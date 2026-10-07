import { SqlDeployLocks } from '@fabrika/platform'
import { type ControlProvider, ProviderInvocationAbort } from '@fabrika/provider-contract'
import { expect, test } from 'bun:test'
import { reconcileProviderRuns, sweepStaleRuns } from '../provider-reconcile'
import { cancelDeploy, executeDeploy, type RunDeps } from '../run-lifecycle'
import { DEPLOY_LEASE_TTL_MS, type DeployLockGate, type OwnershipTiming, RunOwnership } from '../run-ownership'
import { EnvSecretResolver } from '../secret-resolver'
import { createHarness } from './helpers/harness'
import { providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'

class ManualClock implements OwnershipTiming {
	value = Date.now()
	ttlMs = 90
	pollMs = 10
	private readonly sleepers = new Set<{ at: number; wake(): void }>()
	now = () => this.value
	wait = (ms: number, signal: AbortSignal): Promise<void> =>
		new Promise((resolve, reject) => {
			signal.throwIfAborted()
			const abort = (): void => {
				this.sleepers.delete(entry)
				reject(signal.reason)
			}
			const entry = {
				at: this.value + ms,
				wake: () => {
					signal.removeEventListener('abort', abort)
					resolve()
				},
			}
			this.sleepers.add(entry)
			signal.addEventListener('abort', abort, { once: true })
		})
	async advance(ms: number): Promise<void> {
		this.value += ms
		for (const entry of this.sleepers) {
			if (entry.at <= this.value) {
				this.sleepers.delete(entry)
				entry.wake()
			}
		}
		await flush()
	}
}

async function flush(): Promise<void> {
	for (let i = 0; i < 40; i++) await Promise.resolve()
}

async function fixture() {
	const clock = new ManualClock()
	const harness = createHarness(() => Math.floor(clock.now() / 1000))
	const { db, d1 } = harness
	await db.registry.createApp({ id: 'app', repoUrl: 'https://github.com/example/app' })
	await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
	const row = await db.runs.createRun({ id: 'run', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
	const locks = new SqlDeployLocks(d1, { now: clock.now })
	const lock: DeployLockGate = {
		acquire: (key, holder) => locks.acquire(key, holder, clock.ttlMs),
		renew: (key, holder) => locks.renew(key, holder, clock.ttlMs),
		release: (key, holder) => locks.release(key, holder),
	}
	const provider: ControlProvider = { id: TEST_PROVIDER_ID, normalizeRegistration: (input) => input, deploy: async () => ({ state: 'succeeded' }) }
	const deps: RunDeps = { repositories: db, lock, provider, ownershipTiming: clock, secrets: new EnvSecretResolver({}), logs: { put: async () => {} } }
	return { ...harness, clock, lock, deps, row }
}

for (const result of ['resolve', 'reject']) {
	test(`close abandons a hanging observer read and safely handles its late ${result}`, async () => {
		const { db, clock, lock, row } = await fixture()
		const owner = await RunOwnership.acquire(db.runs, lock, row, clock)
		if (owner === null) throw new Error('owner missing')
		const pending = Promise.withResolvers<typeof row | null>()
		db.runs.getRun = () => pending.promise
		await clock.advance(10)
		await owner.close()
		expect(await lock.acquire('app:prod', 'replacement')).toBe(true)
		if (result === 'resolve') pending.resolve({ ...row, cancel_requested_at: 1 })
		else pending.reject(new Error('late read failure'))
		await flush()
		expect(owner.work.signal.reason).toBeInstanceOf(ProviderInvocationAbort)
		expect(owner.work.signal.reason.kind).toBe('lease_lost')
	})
}

test("a dead holder's lease is re-acquirable within the production TTL plus one renew period", async () => {
	const { db, clock, row, lock } = await fixture()
	clock.ttlMs = DEPLOY_LEASE_TTL_MS
	const renewedAt: number[] = []
	const recording: DeployLockGate = {
		...lock,
		renew: (key, holder) => {
			renewedAt.push(clock.now())
			return lock.renew(key, holder)
		},
	}
	const start = clock.now()
	const owner = await RunOwnership.acquire(db.runs, recording, row, clock)
	if (owner === null) throw new Error('owner missing')
	for (let i = 0; i < 6; i++) await clock.advance(10_000)
	expect(DEPLOY_LEASE_TTL_MS).toBe(90_000)
	expect(renewedAt).toEqual([start + 30_000, start + 60_000])
	// A dead process stops renewing without releasing its row.
	owner.invalidate()
	expect(await lock.acquire('app:prod', 'replacement')).toBe(false)
	await clock.advance(DEPLOY_LEASE_TTL_MS + DEPLOY_LEASE_TTL_MS / 3)
	expect(await lock.acquire('app:prod', 'replacement')).toBe(true)
	await owner.close()
})

test('cancellation during reservation records initial identity and cleans it without submitting work', async () => {
	const { db, deps, row } = await fixture()
	let submitted = false
	const cancelled: string[] = []
	deps.provider.deploy = async (input) => {
		await cancelDeploy(deps, row)
		await input.events.externalId('reserved-version', { phase: 'version_created' })
		input.signal.throwIfAborted()
		submitted = true
		return { state: 'succeeded' }
	}
	deps.provider.cancel = async (input) => {
		cancelled.push(input.externalId)
		return { state: 'settled' }
	}
	expect(await executeDeploy(deps, { runId: row.id })).toEqual({ runId: row.id, status: 'skipped' })
	expect(cancelled).toEqual(['reserved-version'])
	expect(submitted).toBe(false)
	expect((await db.runs.getRun(row.id))?.external_run_id).toBe('reserved-version')
	expect((await db.runs.getRun(row.id))?.status).toBe('failed')
})

test('renewal throughout slow source resolution excludes sweep and recovery', async () => {
	const { db, deps, clock, sqlite } = await fixture()
	const entered = Promise.withResolvers<void>()
	const resolved = Promise.withResolvers<void>()
	deps.provider.resolveSource = async () => {
		entered.resolve()
		await resolved.promise
		return { commitSha: 'a'.repeat(40) }
	}
	const deploy = executeDeploy(deps, { runId: 'run' })
	await entered.promise
	sqlite.run('UPDATE runs SET started_at = started_at - 7200 WHERE id = ?', ['run'])
	for (let i = 0; i < 12; i++) await clock.advance(30)
	expect(await sweepStaleRuns(deps, 1800, () => Math.floor(clock.now() / 1000))).toBe(0)
	expect(await reconcileProviderRuns(deps)).toMatchObject({ inProgress: 1, failed: 0 })
	expect((await db.runs.getRun('run'))?.status).toBe('running')
	resolved.resolve()
	expect(await deploy).toEqual({ runId: 'run', status: 'succeeded' })
})

for (const failure of ['false', 'error', 'hanging']) {
	test(`a ${failure} renewal aborts ownership and stale writes cannot affect takeover`, async () => {
		const { db, clock, lock, row } = await fixture()
		const lateRenewal = Promise.withResolvers<boolean>()
		const owner = await RunOwnership.acquire(
			db.runs,
			{
				...lock,
				renew: () => failure === 'false' ? Promise.resolve(false) : failure === 'error' ? Promise.reject(new Error('offline')) : lateRenewal.promise,
			},
			row,
			clock,
		)
		if (owner === null) throw new Error('owner missing')
		await owner.mutate((guard) => db.runs.markRunStarted(row.id, 'logs', guard))
		await owner.mutate((guard) => db.runs.setRunExternalId(row.id, 'version', { phase: 1 }, guard), { phase: 1 }, true)
		const staleGuard = owner.guard()
		await clock.advance(30)
		if (failure === 'hanging') expect(owner.ownership.signal.aborted).toBe(false)
		await clock.advance(61)
		expect(owner.ownership.signal.reason).toBeInstanceOf(ProviderInvocationAbort)
		expect(owner.lost).toBe(true)
		const replacement = await RunOwnership.acquire(db.runs, lock, row, clock)
		if (replacement === null) throw new Error('takeover missing')
		await replacement.mutate((guard) => db.runs.checkpointRunProviderState(row.id, { phase: 2 }, guard), { phase: 2 })
		const guard = { ...staleGuard, nowMs: clock.now() }
		expect(await db.runs.setRunCommit(row.id, 'late', guard)).toBe(false)
		expect(await db.runs.checkpointRunProviderState(row.id, { phase: 3 }, guard)).toBe(false)
		expect(await db.runs.markRunFinished(row.id, 'failed', 1, guard)).toBe(false)
		await replacement.mutate((current) => db.runs.markRunFinished(row.id, 'succeeded', 0, current))
		await owner.close()
		lateRenewal.resolve(true)
		expect(await lock.acquire('app:prod', 'intruder')).toBe(false)
		await replacement.close()
		expect((await db.runs.getRun(row.id))?.status).toBe('succeeded')
	})
}

test('checkpoint CAS is sequential and a rejected checkpoint poisons later events', async () => {
	const { db, clock, lock, row } = await fixture()
	const owner = await RunOwnership.acquire(db.runs, lock, row, clock)
	if (owner === null) throw new Error('owner missing')
	await owner.mutate((guard) => db.runs.markRunStarted(row.id, 'logs', guard))
	const accepted = owner.mutate((guard) => db.runs.setRunExternalId(row.id, 'version', { phase: 1 }, guard), { phase: 1 }, true)
	const checkpoint = owner.mutate((guard) => db.runs.checkpointRunProviderState(row.id, { phase: 2 }, guard), { phase: 2 })
	await Promise.all([accepted, checkpoint])
	expect((await db.runs.getRun(row.id))?.provider_state_json).toBe('{"phase":2}')
	await db.runs.checkpointRunProviderState(row.id, { phase: 'changed elsewhere' })
	await expect(owner.mutate((guard) => db.runs.checkpointRunProviderState(row.id, { phase: 3 }, guard), { phase: 3 })).rejects.toThrow(
		'lost its lease',
	)
	await expect(owner.mutate((guard) => db.runs.markRunFinished(row.id, 'failed', 1, guard))).rejects.toThrow('lost its lease')
	expect((await db.runs.getRun(row.id))?.status).toBe('running')
	await owner.close()
})

test('accepted unresolved work excludes another run after the invocation releases its lease', async () => {
	const { db, deps } = await fixture()
	deps.provider.deploy = async (input) => {
		await input.events.externalId('version')
		throw new Error('response lost')
	}
	expect(await executeDeploy(deps, { runId: 'run' })).toEqual({ runId: 'run', status: 'running' })
	await db.runs.createRun({ id: 'next', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
	expect(await executeDeploy(deps, { runId: 'next' })).toEqual({ runId: 'next', status: 'deferred' })
	expect((await db.runs.getRun('next'))?.status).toBe('pending')
})

test('an ambiguous persistence error invalidates the invocation without terminalizing accepted work', async () => {
	const { db, clock, lock, row } = await fixture()
	const owner = await RunOwnership.acquire(db.runs, lock, row, clock)
	if (owner === null) throw new Error('owner missing')
	await owner.mutate((guard) => db.runs.markRunStarted(row.id, 'logs', guard))
	await expect(owner.mutate(
		async (guard) => {
			await db.runs.setRunExternalId(row.id, 'version', { phase: 'accepted' }, guard)
			throw new Error('database response lost')
		},
		{ phase: 'accepted' },
		true,
	)).rejects.toThrow('database response lost')
	expect(owner.lost).toBe(true)
	await expect(owner.mutate((guard) => db.runs.markRunFinished(row.id, 'failed', null, guard))).rejects.toThrow('database response lost')
	expect((await db.runs.getRun(row.id))?.status).toBe('running')
	expect((await db.runs.getRun(row.id))?.external_run_id).toBe('version')
	await owner.close()
})

test('late IAM failure after lease loss cannot correct a fast runner success', async () => {
	const { db, deps, clock, row, lock } = await fixture()
	const entered = Promise.withResolvers<void>()
	const iamFinished = Promise.withResolvers<void>()
	deps.provider.deploy = async (input) => {
		await input.events.externalId('runner')
		await db.runs.markRunFinished(row.id, 'succeeded', 0)
		entered.resolve()
		await iamFinished.promise
		return { state: 'failed' }
	}
	const deploying = executeDeploy(deps, { runId: row.id })
	await entered.promise
	await clock.advance(91)
	const replacement = await RunOwnership.acquire(db.runs, lock, row, clock)
	if (replacement === null) throw new Error('takeover missing')
	iamFinished.resolve()
	expect(await deploying).toEqual({ runId: row.id, status: 'running' })
	expect((await db.runs.getRun(row.id))?.status).toBe('succeeded')
	expect(await lock.acquire('app:prod', 'intruder')).toBe(false)
	await replacement.close()
})

test('missing cancellation capability never settles accepted work', async () => {
	const { db, deps, row } = await fixture()
	deps.provider.deploy = async (input) => {
		await input.events.externalId('version')
		return { state: 'running' }
	}
	await executeDeploy(deps, { runId: row.id })
	await cancelDeploy(deps, row)
	expect((await db.runs.getRun(row.id))?.status).toBe('running')
	expect((await db.runs.getRun(row.id))?.cancel_requested_at).not.toBeNull()
	expect(await reconcileProviderRuns(deps)).toMatchObject({ failed: 0, inProgress: 1 })
})

test('a no-id crash is settled only after takeover, while pending queue work is retained', async () => {
	const { db, deps, clock, row, lock } = await fixture()
	const owner = await RunOwnership.acquire(db.runs, lock, row, clock)
	if (owner === null) throw new Error('owner missing')
	await owner.mutate((guard) => db.runs.markRunStarted(row.id, 'logs', guard))
	await db.runs.createRun({ id: 'queued', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
	expect(await reconcileProviderRuns(deps)).toMatchObject({ failed: 0 })
	await clock.advance(91)
	expect(await reconcileProviderRuns(deps)).toMatchObject({ failed: 1, waiting: 1 })
	expect((await db.runs.getRun('queued'))?.status).toBe('pending')
	await owner.close()
})

test('active owner sees cancellation during source resolution and settles with fresh ownership signal', async () => {
	const { db, deps, row, clock } = await fixture()
	const entered = Promise.withResolvers<void>()
	const signals: AbortSignal[] = []
	deps.provider.resolveSource = async ({ signal }) => {
		entered.resolve()
		await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
		return { commitSha: 'a'.repeat(40) }
	}
	deps.provider.cancel = async ({ signal }) => {
		signals.push(signal)
		return { state: 'settled' }
	}
	const deploying = executeDeploy(deps, { runId: row.id })
	await entered.promise
	await cancelDeploy(deps, row)
	expect((await db.runs.getRun(row.id))?.status).toBe('running')
	await clock.advance(10)
	expect(await deploying).toEqual({ runId: row.id, status: 'skipped' })
	expect((await db.runs.getRun(row.id))?.status).toBe('failed')
	expect(signals).toEqual([])
})

test('active cancellation uses the latest checkpoint and a fresh signal, retaining pending external work', async () => {
	const { db, deps, row, clock } = await fixture()
	const entered = Promise.withResolvers<void>()
	let cancellationSignal: AbortSignal | undefined
	deps.provider.deploy = async (input) => {
		await input.events.externalId('version', { phase: 'accepted' })
		await input.events.checkpoint({ phase: 'submitted' })
		entered.resolve()
		await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }))
		return { state: 'succeeded' }
	}
	deps.provider.cancel = async (input) => {
		expect(input.providerState).toEqual({ phase: 'submitted' })
		expect(input.signal.aborted).toBe(false)
		cancellationSignal = input.signal
		return { state: 'pending' }
	}
	const deploying = executeDeploy(deps, { runId: row.id })
	await entered.promise
	await cancelDeploy(deps, row)
	await clock.advance(10)
	expect(await deploying).toEqual({ runId: row.id, status: 'running' })
	expect(cancellationSignal).toBeDefined()
	expect((await db.runs.getRun(row.id))?.status).toBe('running')
	expect((await db.runs.getRun(row.id))?.cancel_requested_at).not.toBeNull()
	deps.provider.cancel = async () => ({ state: 'settled' })
	expect(await reconcileProviderRuns(deps)).toMatchObject({ failed: 1 })
	expect((await db.runs.getRun(row.id))?.status).toBe('failed')
})
