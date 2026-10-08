import { SqlDeployLocks } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { expect, test } from 'bun:test'
import { acquireLease, LEASE_RENEW_MS, LEASE_TTL_MS } from '../lease'
import { reconcileProviderRuns, sweepStaleRuns } from '../provider-reconcile'
import { cancelDeploy, executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { createHarness } from './helpers/harness'
import { flush, ManualClock, RecordingLocks } from './helpers/lease'
import { providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'

async function fixture() {
	const clock = new ManualClock()
	const harness = createHarness(() => Math.floor(clock.now() / 1000))
	const { db, d1 } = harness
	await db.registry.createApp({ id: 'app', repoUrl: 'https://github.com/example/app' })
	await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
	const row = await db.runs.createRun({ id: 'run', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
	const locks = new RecordingLocks(new SqlDeployLocks(d1, { now: clock.now }), clock)
	const advance = (ms: number) => clock.advance(ms, locks.idle)
	const provider: ControlProvider = { id: TEST_PROVIDER_ID, normalizeRegistration: (input) => input, deploy: async () => ({ state: 'succeeded' }) }
	const deps: RunDeps = {
		repositories: db,
		lock: locks,
		leaseClock: clock,
		provider,
		secrets: new VaultSecretResolver({}),
		logs: { put: async () => {} },
	}
	return { ...harness, clock, locks, advance, deps, row }
}

test('cancellation during reservation records initial identity and cleans it without submitting work', async () => {
	const { db, deps, row } = await fixture()
	let submitted = false
	const cancelled: string[] = []
	deps.provider.deploy = async (input) => {
		await cancelDeploy(deps, row)
		await input.events.externalId('reserved-version', { appVersionId: 'reserved-version', triggered: false })
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
	const { db, deps, clock, advance, sqlite } = await fixture()
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
	for (let i = 0; i < 12; i++) await advance(LEASE_RENEW_MS)
	expect(await sweepStaleRuns(deps, 1800, () => Math.floor(clock.now() / 1000))).toBe(0)
	expect(await reconcileProviderRuns(deps)).toMatchObject({ inProgress: 1, failed: 0 })
	expect((await db.runs.getRun('run'))?.status).toBe('running')
	resolved.resolve()
	expect(await deploy).toEqual({ runId: 'run', status: 'succeeded' })
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
	const { db, deps, row } = await fixture()
	const record = db.runs.recordInitialRunExternalId.bind(db.runs)
	db.runs.recordInitialRunExternalId = async (...args) => {
		await record(...args)
		throw new Error('database response lost')
	}
	deps.provider.deploy = async (input) => {
		await input.events.externalId('version', { appVersionId: 'version', triggered: false })
		return { state: 'succeeded' }
	}
	expect(await executeDeploy(deps, { runId: row.id })).toEqual({ runId: row.id, status: 'running' })
	expect((await db.runs.getRun(row.id))?.status).toBe('running')
	expect((await db.runs.getRun(row.id))?.external_run_id).toBe('version')
})

test('late IAM failure after lease loss cannot correct a fast runner success', async () => {
	const { db, deps, clock, advance, row, locks } = await fixture()
	const entered = Promise.withResolvers<void>()
	const iamFinished = Promise.withResolvers<void>()
	deps.provider.deploy = async (input) => {
		await input.events.externalId('runner')
		entered.resolve()
		await iamFinished.promise
		return { state: 'failed' }
	}
	const deploying = executeDeploy(deps, { runId: row.id })
	await entered.promise
	await advance(LEASE_TTL_MS + 1)
	const replacement = await acquireLease(locks, 'app:prod', clock)
	if (replacement === null) throw new Error('takeover missing')
	expect(await db.runs.markRunFinished(row.id, 'succeeded', 0, replacement.fence())).toBe(true)
	iamFinished.resolve()
	expect(await deploying).toEqual({ runId: row.id, status: 'running' })
	expect((await db.runs.getRun(row.id))?.status).toBe('succeeded')
	expect(await acquireLease(locks, 'app:prod', clock)).toBeNull()
	await replacement.release()
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
	const { db, deps, clock, advance, row, locks } = await fixture()
	const crashed = await acquireLease(locks, 'app:prod', clock)
	if (crashed === null) throw new Error('lease missing')
	expect(await db.runs.markRunStarted(row.id, 'logs', crashed.fence())).toBe(true)
	await db.runs.createRun({ id: 'queued', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
	expect(await reconcileProviderRuns(deps)).toMatchObject({ failed: 0 })
	// The process dies: its lease is never renewed and never released.
	locks.renewal = 'hanging'
	await advance(LEASE_TTL_MS + 1)
	locks.renewal = 'live'
	expect(await reconcileProviderRuns(deps)).toMatchObject({ failed: 1, waiting: 1 })
	expect((await db.runs.getRun('queued'))?.status).toBe('pending')
	await crashed.release()
})

test('a cancellation during a step stops at the next boundary, with no row poll while the step runs', async () => {
	const { db, deps, row, advance } = await fixture()
	const entered = Promise.withResolvers<void>()
	const resolved = Promise.withResolvers<void>()
	const signals: AbortSignal[] = []
	let reads = 0
	const getRun = db.runs.getRun.bind(db.runs)
	db.runs.getRun = (id) => {
		reads++
		return getRun(id)
	}
	let deployed = false
	deps.provider.resolveSource = async () => {
		entered.resolve()
		await resolved.promise
		return { commitSha: 'a'.repeat(40) }
	}
	deps.provider.deploy = async () => {
		deployed = true
		return { state: 'succeeded' }
	}
	deps.provider.cancel = async ({ signal }) => {
		signals.push(signal)
		return { state: 'settled' }
	}
	const deploying = executeDeploy(deps, { runId: row.id })
	await entered.promise
	await cancelDeploy(deps, row)
	expect((await db.runs.getRun(row.id))?.status).toBe('running')
	const readsDuringStep = reads
	for (let i = 0; i < 5; i++) await advance(1000)
	await flush()
	expect(reads).toBe(readsDuringStep)
	resolved.resolve()
	expect(await deploying).toEqual({ runId: row.id, status: 'skipped' })
	expect(deployed).toBe(false)
	expect((await db.runs.getRun(row.id))?.status).toBe('failed')
	expect(signals).toEqual([])
})

test('active cancellation uses the latest checkpoint and the live lease signal, retaining pending external work', async () => {
	const { db, deps, row } = await fixture()
	const entered = Promise.withResolvers<void>()
	const proceed = Promise.withResolvers<void>()
	let cancellationSignal: AbortSignal | undefined
	deps.provider.deploy = async (input) => {
		await input.events.externalId('version', { appVersionId: 'version', triggered: false })
		await input.events.checkpoint({ appVersionId: 'version', triggered: true })
		entered.resolve()
		await proceed.promise
		await input.events.boundary()
		return { state: 'succeeded' }
	}
	deps.provider.cancel = async (input) => {
		expect(input.providerState).toEqual({ appVersionId: 'version', triggered: true })
		expect(input.signal.aborted).toBe(false)
		cancellationSignal = input.signal
		return { state: 'pending' }
	}
	const deploying = executeDeploy(deps, { runId: row.id })
	await entered.promise
	await cancelDeploy(deps, row)
	proceed.resolve()
	expect(await deploying).toEqual({ runId: row.id, status: 'running' })
	expect(cancellationSignal).toBeDefined()
	expect((await db.runs.getRun(row.id))?.status).toBe('running')
	expect((await db.runs.getRun(row.id))?.cancel_requested_at).not.toBeNull()
	deps.provider.cancel = async () => ({ state: 'settled' })
	expect(await reconcileProviderRuns(deps)).toMatchObject({ failed: 1 })
	expect((await db.runs.getRun(row.id))?.status).toBe('failed')
})

test('a lease lost during a provider step leaves the run running and asks the provider to cancel nothing', async () => {
	const { db, deps, row, advance, locks } = await fixture()
	const entered = Promise.withResolvers<void>()
	const proceed = Promise.withResolvers<void>()
	const cancels: string[] = []
	deps.provider.deploy = async (input) => {
		await input.events.externalId('version', { appVersionId: 'version', triggered: false })
		entered.resolve()
		await proceed.promise
		await input.events.boundary()
		return { state: 'succeeded' }
	}
	deps.provider.cancel = async (input) => {
		cancels.push(input.externalId)
		return { state: 'settled' }
	}
	const deploying = executeDeploy(deps, { runId: row.id })
	await entered.promise
	locks.renewal = 'refused'
	await advance(LEASE_RENEW_MS)
	await cancelDeploy({ ...deps, lock: locks }, row)
	proceed.resolve()
	expect(await deploying).toEqual({ runId: row.id, status: 'running' })
	expect(cancels).toEqual([])
	expect((await db.runs.getRun(row.id))?.status).toBe('running')
})

test('the next deploy settles a run a dead holder left running, within one TTL and without the cron', async () => {
	const { db, deps, clock, advance, row, locks } = await fixture()
	const crashed = await acquireLease(locks, 'app:prod', clock)
	if (crashed === null) throw new Error('lease missing')
	expect(await db.runs.markRunStarted(row.id, 'logs', crashed.fence())).toBe(true)
	// The process dies: its lease is never renewed and never released.
	locks.renewal = 'hanging'
	await db.runs.createRun({ id: 'next', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
	expect(await executeDeploy(deps, { runId: 'next' })).toEqual({ runId: 'next', status: 'deferred' })
	await advance(LEASE_TTL_MS)
	locks.renewal = 'live'
	expect(await executeDeploy(deps, { runId: 'next' })).toEqual({ runId: 'next', status: 'succeeded' })
	expect((await db.runs.getRun(row.id))?.status).toBe('failed')
	await crashed.release()
})

test('the next deploy defers while the run it would settle still has external work in flight', async () => {
	const { db, deps, row } = await fixture()
	const reconciled: string[] = []
	deps.provider.deploy = async (input) => {
		await input.events.externalId('version', { appVersionId: 'version', triggered: true })
		return { state: 'running' }
	}
	deps.provider.reconcile = async (input) => {
		reconciled.push(input.externalId)
		return { state: 'running' }
	}
	expect(await executeDeploy(deps, { runId: row.id })).toEqual({ runId: row.id, status: 'running' })
	await db.runs.createRun({ id: 'next', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
	expect(await executeDeploy(deps, { runId: 'next' })).toEqual({ runId: 'next', status: 'deferred' })
	expect(reconciled).toEqual(['version'])
	deps.provider.reconcile = async () => ({ state: 'succeeded' })
	deps.provider.deploy = async () => ({ state: 'succeeded' })
	expect(await executeDeploy(deps, { runId: 'next' })).toEqual({ runId: 'next', status: 'succeeded' })
	expect((await db.runs.getRun(row.id))?.status).toBe('succeeded')
})
