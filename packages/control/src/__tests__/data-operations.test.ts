// Control drives a data operation on an environment's object (ADR-0069 §3) against a fake ops endpoint that keeps a
// published state the way the object does, with the real SQL lease on SQLite always and on Postgres when
// FABRIKA_TEST_POSTGRES_URL is set.

import type { AuthContext } from '@fabrika/auth'
import {
	type OpsContentView,
	type OpsInspectRequest,
	type OpsMaintenance,
	type OpsPublishedState,
	type OpsStateAck,
	type OpsStateRequest,
	opsTransitionRefused,
} from '@fabrika/auth-core'
import { type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { type ControlProvider, ProviderInvocationAbort } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	advanceDataOperation,
	type DataOperationDeps,
	httpOpsTransport,
	type OpsAnswer,
	type OpsDataAnswer,
	type OpsFencedAnswer,
	type OpsInspection,
	type OpsTarget,
	type OpsTransport,
	recordedMaintenance,
	startMaintenance,
	startRecovery,
} from '../data-operations'
import { type ControlRepositories, createControlRepositories } from '../db'
import { acquireLease, LEASE_TTL_MS, runLeaseKey } from '../lease'
import { executeDeploy, executeDeployUnderLease, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { authWithActions, authWithPermissions } from './helpers/iam'
import { ManualClock } from './helpers/lease'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider, providerEnvironment } from './helpers/provider'
import { rpcRequest, rpcResult } from './helpers/rpc'

if (!hasPostgres) console.warn(`data-operations.test.ts Postgres half ${skipReason}`)

const APP = 'crm'
const ENV = 'prod'
const TARGET: OpsTarget = { appId: APP, env: ENV }
const KEY = runLeaseKey(APP, ENV)

/**
 * What the fake object does with one transition: answer it, apply it and lose the answer, never receive it, or answer
 * the 501 of a release that does not serve it.
 */
type Behaviour = 'answer' | 'lose' | 'down' | 'not_served'

type Sent =
	| { readonly op: 'inspect'; readonly content: boolean }
	| { readonly op: 'state'; readonly generation: number; readonly mode: OpsStateRequest['mode'] }

/** The object as Control sees it: a published state judged by the wire's own rule, and every request it was sent. */
class FakeObject implements OpsTransport {
	published: OpsPublishedState | null = null
	readonly sent: Sent[] = []
	behaviour: (request: OpsStateRequest) => Behaviour | Promise<Behaviour> = () => 'answer'
	reachable = true

	inspect(_target: OpsTarget, request: OpsInspectRequest): Promise<OpsAnswer<OpsInspection>> {
		this.sent.push({ op: 'inspect', content: request.content })
		if (!this.reachable) return Promise.resolve({ kind: 'unavailable', reason: 'unreachable' })
		const maintenance: OpsMaintenance = this.published === null
			? { mode: 'open', generation: null, published: false }
			: { ...this.published, published: true }
		const value: OpsInspection = request.content
			? { content: true, view: contentView(maintenance) }
			: { content: false, view: { ...contentView(maintenance), bootFailure: { at: BOOT_FAILED_AT } } }
		return Promise.resolve({ kind: 'ok', value })
	}

	async state(_target: OpsTarget, request: OpsStateRequest): Promise<OpsFencedAnswer<OpsStateAck>> {
		this.sent.push({ op: 'state', generation: request.generation, mode: request.mode })
		const behaviour = await this.behaviour(request)
		if (!this.reachable || behaviour === 'down') return { kind: 'unavailable', reason: 'unreachable' }
		if (behaviour === 'not_served') return { kind: 'unavailable', reason: 'not_served' }
		if (opsTransitionRefused(this.published, request)) return { kind: 'stale', published: this.published }
		this.published = { generation: request.generation, mode: request.mode }
		if (behaviour === 'lose') return { kind: 'unavailable', reason: 'unreachable' }
		return { kind: 'ok', value: { generation: request.generation, mode: request.mode, stillRunning: 0 } }
	}

	migrate(): Promise<OpsFencedAnswer<never>> {
		return Promise.resolve({ kind: 'unavailable', reason: 'invalid_answer' })
	}

	export(): Promise<OpsDataAnswer<never>> {
		return Promise.resolve({ kind: 'unavailable', reason: 'invalid_answer' })
	}

	import(): Promise<OpsDataAnswer<never>> {
		return Promise.resolve({ kind: 'unavailable', reason: 'invalid_answer' })
	}

	restore(): Promise<OpsDataAnswer<never>> {
		return Promise.resolve({ kind: 'unavailable', reason: 'invalid_answer' })
	}

	transitions(): { generation: number; mode: string }[] {
		return this.sent.flatMap((sent) => sent.op === 'state' ? [{ generation: sent.generation, mode: sent.mode }] : [])
	}
}

const BOOT_FAILED_AT = '2026-10-24T10:00:00.000Z'

function contentView(maintenance: OpsMaintenance): OpsContentView {
	return {
		release: '0.9.0',
		maintenance,
		database: { sizeBytes: 4096, tables: [{ name: 'notes', rows: 3 }] },
		migrations: [],
		scheduler: { alarm: null },
		jobs: [],
		files: [],
		webhooks: [],
		bootFailure: { at: BOOT_FAILED_AT, message: 'tenant 7 broke the boot', stack: 'at boot (app.ts:1)' },
	}
}

interface Backend {
	repositories: ControlRepositories
	db: SqlDatabase
	close(): Promise<void>
}

const backends: { name: string; skip: boolean; open(): Promise<Backend> }[] = [
	{
		name: 'sqlite',
		skip: false,
		open: () => {
			const harness = createHarness()
			return Promise.resolve({
				repositories: harness.repositories,
				db: harness.d1,
				close: () => {
					harness.sqlite.close()
					return Promise.resolve()
				},
			})
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async () => {
			const fixture = await createPostgres('data_operations')
			return { repositories: createControlRepositories(fixture.db), db: fixture.db, close: () => fixture.close() }
		},
	},
]

for (const backend of backends) {
	describe.skipIf(backend.skip)(`data operations (${backend.name})`, () => {
		let opened: Backend | null = null

		afterEach(async () => {
			await opened?.close()
			opened = null
		})

		async function open(): Promise<{ b: Backend; object: FakeObject; deps(clock?: ManualClock): DataOperationDeps }> {
			const b = await backend.open()
			opened = b
			await b.repositories.registry.createApp({ id: APP, repoUrl: 'github.com/acme/crm' })
			await b.repositories.registry.upsertAppEnv(providerEnvironment(APP, ENV, { domain: 'crm.example.com' }))
			const object = new FakeObject()
			return {
				b,
				object,
				deps: (clock) => ({
					repositories: b.repositories,
					lock: new SqlDeployLocks(b.db, clock === undefined ? {} : { now: clock.now }),
					...(clock === undefined ? {} : { leaseClock: clock }),
					ops: object,
				}),
			}
		}

		/** An operation whose object never answered: it keeps running at its step, holding the environment restricted. */
		async function stuckReadOnly(deps: DataOperationDeps, object: FakeObject): Promise<string> {
			object.behaviour = () => 'down'
			const outcome = await startMaintenance(deps, { ...TARGET, mode: 'read-only', actor: 'user:test' })
			if (outcome.kind !== 'driven') throw new Error('the operation was not recorded')
			expect(outcome.result).toBe('interrupted')
			expect(outcome.operation).toMatchObject({ state: 'running', step: 'restrict', generation: 1 })
			object.behaviour = () => 'answer'
			return outcome.operation.id
		}

		test('a transition publishes a fresh generation and finishes on its acknowledgement', async () => {
			const { b, object, deps } = await open()
			const outcome = await startMaintenance(deps(), { ...TARGET, mode: 'read-only', actor: 'user:test' })
			expect(outcome).toMatchObject({ kind: 'driven', result: 'succeeded', operation: { state: 'succeeded', generation: 1 } })
			expect(object.published).toEqual({ generation: 1, mode: 'read-only' })
			expect(await recordedMaintenance(b, TARGET)).toBe('read-only')
			expect(await startMaintenance(deps(), { ...TARGET, mode: 'open', actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
			expect(object.published).toEqual({ generation: 2, mode: 'open' })
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('a lost answer repeats the same generation and mode, and allocates nothing new', async () => {
			const { b, object, deps } = await open()
			let first = true
			object.behaviour = () => {
				const behaviour = first ? 'lose' : 'answer'
				first = false
				return behaviour
			}
			const outcome = await startMaintenance(deps(), { ...TARGET, mode: 'closed', actor: 'user:test' })
			expect(outcome).toMatchObject({ result: 'succeeded', operation: { generation: 1 } })
			expect(object.transitions()).toEqual([{ generation: 1, mode: 'closed' }, { generation: 1, mode: 'closed' }])
			expect(await b.repositories.dataOperations.allocateGeneration(APP, ENV)).toBe(2)
		})

		test('an environment Control cannot reach gets no record, and a stuck operation is recovered, never overtaken', async () => {
			const { b, object, deps } = await open()
			object.reachable = false
			expect(await startMaintenance(deps(), { ...TARGET, mode: 'read-only', actor: 'user:test' })).toEqual({ kind: 'refused', reason: 'unreachable' })
			expect(await b.repositories.dataOperations.listForEnvironment(APP, ENV, { limit: 10 })).toEqual([])
			object.reachable = true
			await stuckReadOnly(deps(), object)
			expect(await recordedMaintenance(b, TARGET)).toBe('unsettled')
			expect(await startMaintenance(deps(), { ...TARGET, mode: 'open', actor: 'user:test' })).toEqual({ kind: 'refused', reason: 'operation_running' })
		})

		test('recovery publishes closed at a fresh generation, then resumes the interrupted operation', async () => {
			const { b, object, deps } = await open()
			const stuck = await stuckReadOnly(deps(), object)
			object.sent.length = 0
			const outcome = await startRecovery(deps(), { ...TARGET, operationId: stuck, resolution: 'resume', actor: 'user:ops' })
			expect(outcome).toMatchObject({
				kind: 'driven',
				result: 'succeeded',
				operation: { kind: 'recovery', state: 'succeeded', target_mode: 'read-only' },
			})
			expect(object.sent).toEqual([
				{ op: 'inspect', content: false },
				{ op: 'state', generation: 2, mode: 'closed' },
				{ op: 'state', generation: 3, mode: 'read-only' },
			])
			expect(await b.repositories.dataOperations.get(stuck)).toMatchObject({ state: 'succeeded', generation: 3 })
			expect(await recordedMaintenance(b, TARGET)).toBe('read-only')
		})

		test('recovery publishes closed, then opens at a new generation and retires the interrupted operation', async () => {
			const { b, object, deps } = await open()
			const stuck = await stuckReadOnly(deps(), object)
			object.sent.length = 0
			const outcome = await startRecovery(deps(), { ...TARGET, operationId: stuck, resolution: 'open', actor: 'user:ops' })
			expect(outcome).toMatchObject({ result: 'succeeded', operation: { step: 'open', target_mode: 'open', generation: 3 } })
			expect(object.transitions()).toEqual([{ generation: 2, mode: 'closed' }, { generation: 3, mode: 'open' }])
			expect(await b.repositories.dataOperations.get(stuck)).toMatchObject({ state: 'failed', error_code: 'recovered_open' })
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('an opening recovery of an interrupted recovery retires the whole chain, so the oldest operation cannot close the object', async () => {
			const { b, object, deps } = await open()
			const lines: string[] = []
			const maintenance = await stuckReadOnly(deps(), object)
			// The first recovery fences in closed, then loses the object while it resumes the maintenance.
			object.behaviour = (request) => request.mode === 'read-only' ? 'down' : 'answer'
			const first = await startRecovery(deps(), { ...TARGET, operationId: maintenance, resolution: 'resume', actor: 'user:ops' })
			if (first.kind !== 'driven') throw new Error('the recovery was not recorded')
			expect(first).toMatchObject({ result: 'interrupted', operation: { state: 'running', step: 'resume' } })
			object.behaviour = () => 'answer'
			const second = await startRecovery(deps(), { ...TARGET, operationId: first.operation.id, resolution: 'open', actor: 'user:ops' })
			expect(second).toMatchObject({ result: 'succeeded', operation: { state: 'succeeded', target_mode: 'open' } })
			expect(await b.repositories.dataOperations.get(first.operation.id)).toMatchObject({ state: 'failed', error_code: 'recovered_open' })
			expect(await b.repositories.dataOperations.get(maintenance)).toMatchObject({ state: 'failed', error_code: 'recovered_open' })
			const published = object.published
			object.sent.length = 0
			expect(await advanceDataOperation(deps(), maintenance)).toEqual({ kind: 'refused', reason: 'superseded' })
			expect(object.sent).toEqual([])
			expect(object.published).toEqual(published)
			expect(object.published?.mode).toBe('open')
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
			// The record and the object agree, so a deploy runs.
			const run = uuidv7()
			await b.repositories.runs.createRun({ id: run, appId: APP, env: ENV, ref: 'main', trigger: 'manual', actor: 'user:test' })
			const runDeps: RunDeps = {
				repositories: b.repositories,
				lock: new SqlDeployLocks(b.db),
				secrets: new VaultSecretResolver({}),
				provider: fakeControlProvider,
				logs: {
					put: (_key, contents) => {
						if (typeof contents === 'string') lines.push(contents)
						return Promise.resolve()
					},
				},
			}
			expect(await executeDeploy(runDeps, { runId: run, dryRun: true })).toEqual({ runId: run, status: 'succeeded' })
		})

		test('advancing an operation a newer one superseded is refused without calling the object', async () => {
			const { b, object, deps } = await open()
			const clock = new ManualClock()
			const operationDeps = deps(clock)
			// An older operation left running by a dead holder, and a newer one recorded after it.
			const holder = await acquireLease(operationDeps.lock, KEY, clock)
			if (holder === null) throw new Error('lease missing')
			const record = async (targetMode: 'read-only' | 'closed') => {
				const id = uuidv7()
				const generation = await b.repositories.dataOperations.allocateGeneration(APP, ENV)
				const fields = { id, appId: APP, env: ENV, step: 'restrict', targetMode, generation, actor: 'user:test' } as const
				expect(await b.repositories.dataOperations.create({ ...fields, kind: 'maintenance' }, holder.fence())).not.toBeNull()
				return id
			}
			const older = await record('read-only')
			const newer = await record('closed')
			await clock.advance(LEASE_TTL_MS + 1)
			expect(await advanceDataOperation(operationDeps, older)).toEqual({ kind: 'refused', reason: 'superseded' })
			expect(object.sent).toEqual([])
			expect(await b.repositories.dataOperations.get(older)).toMatchObject({ state: 'running', generation: 1 })
			expect(await advanceDataOperation(operationDeps, newer)).toMatchObject({ result: 'succeeded', operation: { generation: 3 } })
			expect(object.transitions()).toEqual([{ generation: 3, mode: 'closed' }])
			await holder.release()
		})

		test('after a restart an operation resumes from its recorded step, not from the start', async () => {
			const { b, object, deps } = await open()
			const stuck = await stuckReadOnly(deps(), object)
			// The recovery's closed fence lands; the object stops answering before it opens.
			object.behaviour = (request) => request.mode === 'open' ? 'down' : 'answer'
			const interrupted = await startRecovery(deps(), { ...TARGET, operationId: stuck, resolution: 'open', actor: 'user:ops' })
			if (interrupted.kind !== 'driven') throw new Error('the recovery was not recorded')
			expect(interrupted).toMatchObject({ result: 'interrupted', operation: { state: 'running', step: 'open', generation: 3 } })
			object.behaviour = () => 'answer'
			object.sent.length = 0
			const resumed = await advanceDataOperation(deps(), interrupted.operation.id)
			expect(resumed).toMatchObject({ result: 'succeeded', operation: { state: 'succeeded', generation: 4 } })
			// A successor fences above every reserved generation in the recorded mode, and does nothing the record had done.
			expect(object.sent).toEqual([{ op: 'state', generation: 4, mode: 'open' }])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('a successor fences its dead predecessor: the late request of the former holder is refused', async () => {
			const { b, object, deps } = await open()
			const clock = new ManualClock()
			const operationDeps = deps(clock)
			const dead = await acquireLease(operationDeps.lock, KEY, clock)
			if (dead === null) throw new Error('lease missing')
			const generation = await b.repositories.dataOperations.allocateGeneration(APP, ENV)
			const id = uuidv7()
			const fields = { id, appId: APP, env: ENV, step: 'restrict', targetMode: 'read-only', generation, actor: 'user:test' } as const
			expect(await b.repositories.dataOperations.create({ ...fields, kind: 'maintenance' }, dead.fence())).not.toBeNull()
			expect(await advanceDataOperation(operationDeps, id)).toEqual({ kind: 'busy' })
			// The holder dies with its request still in flight; its lease expires.
			await clock.advance(LEASE_TTL_MS + 1)
			expect(await advanceDataOperation(operationDeps, id)).toMatchObject({ result: 'succeeded', operation: { generation: 2 } })
			expect(await object.state(TARGET, { object: 'application', generation: 1, mode: 'read-only' })).toEqual({
				kind: 'stale',
				published: { generation: 2, mode: 'read-only' },
			})
			await dead.release()
		})

		test('a 409 naming a higher generation is adopted under a held lease, and the transition is sent again above it', async () => {
			const { b, object, deps } = await open()
			let first = true
			object.behaviour = async (): Promise<Behaviour> => {
				if (first) {
					first = false
					// Another driver's generation reached the object first.
					object.published = { generation: await b.repositories.dataOperations.allocateGeneration(APP, ENV), mode: 'closed' }
				}
				return 'answer'
			}
			const outcome = await startMaintenance(deps(), { ...TARGET, mode: 'read-only', actor: 'user:test' })
			expect(outcome).toMatchObject({ result: 'succeeded', operation: { generation: 3 } })
			expect(object.transitions()).toEqual([{ generation: 1, mode: 'read-only' }, { generation: 3, mode: 'read-only' }])
		})

		test('a 409 that cannot be adopted fails the operation, leaving the environment unsettled', async () => {
			const { b, object, deps } = await open()
			object.behaviour = () => {
				object.published = { generation: 1, mode: 'closed' }
				return 'answer'
			}
			const outcome = await startMaintenance(deps(), { ...TARGET, mode: 'read-only', actor: 'user:test' })
			expect(outcome).toMatchObject({ result: 'failed', operation: { state: 'failed', error_code: 'stale_generation', generation: 1 } })
			expect(await recordedMaintenance(b, TARGET)).toBe('unsettled')
		})

		test('a lost lease aborts the operation without effect: no record moves, no request follows', async () => {
			const { b, object, deps } = await open()
			const clock = new ManualClock()
			const operationDeps = deps(clock)
			object.behaviour = async (): Promise<Behaviour> => {
				// The holder stalls past its lease; another holder takes the environment and publishes.
				await clock.advance(LEASE_TTL_MS + 1)
				expect(await operationDeps.lock.acquire(KEY, 'takeover', LEASE_TTL_MS)).toBe(true)
				object.published = { generation: await b.repositories.dataOperations.allocateGeneration(APP, ENV), mode: 'closed' }
				return 'answer'
			}
			const outcome = await startMaintenance(operationDeps, { ...TARGET, mode: 'read-only', actor: 'user:test' })
			expect(outcome).toMatchObject({ result: 'lease_lost', operation: { state: 'running', step: 'restrict', generation: 1 } })
			expect(object.transitions()).toEqual([{ generation: 1, mode: 'read-only' }])
			expect(object.published).toEqual({ generation: 2, mode: 'closed' })
			expect(await b.db.prepare('SELECT holder FROM deploy_locks WHERE lock_key = ?').bind(KEY).first<{ holder: string }>()).toEqual({
				holder: 'takeover',
			})
		})

		describe('deploys', () => {
			function runDeps(b: Backend, lines: string[]): RunDeps {
				return {
					repositories: b.repositories,
					lock: new SqlDeployLocks(b.db),
					secrets: new VaultSecretResolver({}),
					provider: fakeControlProvider,
					logs: {
						put: (_key, contents) => {
							if (typeof contents === 'string') lines.push(contents)
							return Promise.resolve()
						},
					},
				}
			}

			async function run(b: Backend): Promise<string> {
				const id = uuidv7()
				await b.repositories.runs.createRun({ id, appId: APP, env: ENV, ref: 'main', trigger: 'manual', actor: 'user:test' })
				return id
			}

			test('a deploy is refused while the environment is read-only, and runs again once it opens', async () => {
				const { b, deps } = await open()
				const lines: string[] = []
				expect(await startMaintenance(deps(), { ...TARGET, mode: 'read-only', actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
				const refused = await run(b)
				expect(await executeDeploy(runDeps(b, lines), { runId: refused, dryRun: true })).toEqual({ runId: refused, status: 'failed' })
				expect(lines.at(-1)).toContain('the environment is not open (read-only)')
				expect(await startMaintenance(deps(), { ...TARGET, mode: 'open', actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
				const next = await run(b)
				expect(await executeDeploy(runDeps(b, lines), { runId: next, dryRun: true })).toEqual({ runId: next, status: 'succeeded' })
			})

			test('an object whose release does not serve state fails the operation, so the last settled mode stands and deploys run', async () => {
				const { b, object, deps } = await open()
				const lines: string[] = []
				expect(await startMaintenance(deps(), { ...TARGET, mode: 'read-only', actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
				expect(await startMaintenance(deps(), { ...TARGET, mode: 'open', actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
				object.behaviour = () => 'not_served'
				const outcome = await startMaintenance(deps(), { ...TARGET, mode: 'closed', actor: 'user:test' })
				expect(outcome).toMatchObject({ kind: 'driven', result: 'failed', operation: { state: 'failed', error_code: 'not_served' } })
				expect(object.transitions()).toEqual([{ generation: 1, mode: 'read-only' }, { generation: 2, mode: 'open' }, {
					generation: 3,
					mode: 'closed',
				}])
				expect(await recordedMaintenance(b, TARGET)).toBe('open')
				const id = await run(b)
				expect(await executeDeploy(runDeps(b, lines), { runId: id, dryRun: true })).toEqual({ runId: id, status: 'succeeded' })
				// Nothing is left to recover, and the next operation starts.
				object.behaviour = () => 'answer'
				expect(await startMaintenance(deps(), { ...TARGET, mode: 'read-only', actor: 'user:test' })).toMatchObject({ result: 'succeeded' })
				expect(await recordedMaintenance(b, TARGET)).toBe('read-only')
			})

			test('with no operation settled before it, an operation the release did not serve leaves the environment open', async () => {
				const { b, object, deps } = await open()
				object.behaviour = () => 'not_served'
				for (const mode of ['read-only', 'closed'] as const) {
					expect(await startMaintenance(deps(), { ...TARGET, mode, actor: 'user:test' })).toMatchObject({ result: 'failed' })
				}
				expect(await recordedMaintenance(b, TARGET)).toBe('open')
				const id = await run(b)
				expect(await executeDeploy(runDeps(b, []), { runId: id, dryRun: true })).toEqual({ runId: id, status: 'succeeded' })
			})

			test('the operation holding the lease deploys under it; an unrelated deploy stays excluded', async () => {
				const { b } = await open()
				const lines: string[] = []
				const deps = runDeps(b, lines)
				const lease = await acquireLease(deps.lock, KEY)
				if (lease === null) throw new Error('lease missing')
				const holder = lease.fence().holder
				const generation = await b.repositories.dataOperations.allocateGeneration(APP, ENV)
				const restricting = { id: uuidv7(), appId: APP, env: ENV, step: 'deploy', targetMode: 'read-only', generation, actor: 'user:test' } as const
				const own = await run(b)
				expect(await b.repositories.dataOperations.create({ ...restricting, kind: 'migrate', runId: own }, lease.fence())).toMatchObject({ run_id: own })
				const unrelated = await run(b)
				expect(await executeDeploy(deps, { runId: unrelated, dryRun: true })).toEqual({ runId: unrelated, status: 'deferred' })
				expect(await executeDeployUnderLease(deps, { runId: own, dryRun: true }, lease)).toEqual({ runId: own, status: 'succeeded' })
				// The deploy neither released nor broke the operation's lease.
				expect(lease.signal.aborted).toBe(false)
				expect(lease.fence().holder).toBe(holder)
				expect(await b.db.prepare('SELECT holder FROM deploy_locks WHERE lock_key = ?').bind(KEY).first<{ holder: string }>()).toEqual({ holder })
				expect(await executeDeploy(deps, { runId: unrelated, dryRun: true })).toEqual({ runId: unrelated, status: 'deferred' })
				await lease.release()
				// Without the operation's lease, a deploy of an environment that is not open is refused.
				expect(await executeDeploy(deps, { runId: unrelated, dryRun: true })).toEqual({ runId: unrelated, status: 'failed' })
				expect(lines.at(-1)).toContain('the environment is not open (unsettled)')
			})

			test("a lost lease aborts the operation's deploy before it starts, and a lease of another environment deploys nothing", async () => {
				const { b } = await open()
				await b.repositories.registry.upsertAppEnv(providerEnvironment(APP, 'stage', { domain: 'stage.crm.example.com' }))
				const deps = runDeps(b, [])
				const own = await run(b)
				const stage = await acquireLease(deps.lock, runLeaseKey(APP, 'stage'))
				if (stage === null) throw new Error('lease missing')
				expect(executeDeployUnderLease(deps, { runId: own, dryRun: true }, stage)).rejects.toThrow("another environment's lease")
				await stage.release()
				const lease = await acquireLease(deps.lock, KEY)
				if (lease === null) throw new Error('lease missing')
				lease.abandon()
				expect(executeDeployUnderLease(deps, { runId: own, dryRun: true }, lease)).rejects.toBeInstanceOf(ProviderInvocationAbort)
				expect((await b.repositories.runs.getRun(own))?.status).toBe('pending')
				await lease.release()
			})
		})
	})
}

describe('the HTTP ops transport', () => {
	interface Sent {
		url: string
		authorization: string | null
		redirect: RequestRedirect | undefined
		body: unknown
	}

	/** `answer` builds each response afresh, from the key the request carried. */
	async function transport(answer: (key: string) => Response, options: { domain?: string | null; keys?: readonly string[] } = {}) {
		const repositories = createHarness().repositories
		await repositories.registry.createApp({ id: APP, repoUrl: 'github.com/acme/crm' })
		await repositories.registry.upsertAppEnv(
			providerEnvironment(APP, ENV, { domain: options.domain === undefined ? 'crm.example.com' : options.domain }),
		)
		const sent: Sent[] = []
		const ops = httpOpsTransport({
			registry: repositories.registry,
			opsKeysFor: () => Promise.resolve(options.keys ?? ['ops-key']),
			fetch: (url, init) => {
				const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
				const authorization = new Headers(init.headers).get('authorization')
				sent.push({ url, authorization, redirect: init.redirect, body })
				return Promise.resolve(answer(authorization?.replace(/^Bearer /, '') ?? ''))
			},
		})
		return { ops, sent }
	}

	const signal = new AbortController().signal
	const transition = { object: 'application', generation: 4, mode: 'read-only' } as const
	const ack = () => Response.json({ generation: 4, mode: 'read-only', stillRunning: 1 })
	const refusal = () => new Response(null, { status: 404 })

	test("calls the environment's own domain with the ops key, follows no redirect, and parses the acknowledgement", async () => {
		const { ops, sent } = await transport(ack)
		expect(await ops.state(TARGET, transition, signal)).toEqual({ kind: 'ok', value: { generation: 4, mode: 'read-only', stillRunning: 1 } })
		expect(sent).toEqual([{
			url: 'https://crm.example.com/__fabrika/ops/state',
			authorization: 'Bearer ops-key',
			redirect: 'manual',
			body: transition,
		}])
	})

	test('a key the object refuses uniformly moves on to the next candidate, newest first', async () => {
		const { ops, sent } = await transport((key) => key === 'previous-key' ? ack() : refusal(), { keys: ['newest-key', 'previous-key'] })
		expect(await ops.state(TARGET, transition, signal)).toMatchObject({ kind: 'ok' })
		expect(sent.map((request) => request.authorization)).toEqual(['Bearer newest-key', 'Bearer previous-key'])
	})

	test('every candidate refused, or none at all, fails as an unreachable object would', async () => {
		const refused = await transport(refusal, { keys: ['newest-key', 'previous-key'] })
		expect(await refused.ops.state(TARGET, transition, signal)).toEqual({ kind: 'unavailable', reason: 'unreachable' })
		expect(refused.sent).toHaveLength(2)
		const none = await transport(ack, { keys: [] })
		expect(await none.ops.state(TARGET, transition, signal)).toEqual({ kind: 'unavailable', reason: 'unreachable' })
		expect(none.sent).toEqual([])
	})

	test('any answer but the uniform refusal is final: no other key is tried', async () => {
		const answers: [() => Response, OpsFencedAnswer<OpsStateAck>][] = [
			[() => Response.json({ refused: 'stale_generation', published: { generation: 6, mode: 'closed' } }, { status: 409 }), {
				kind: 'stale',
				published: { generation: 6, mode: 'closed' },
			}],
			[() => new Response('not found', { status: 404 }), { kind: 'unavailable', reason: 'channel_refused' }],
			[() => new Response(null, { status: 503 }), { kind: 'unavailable', reason: 'unreachable' }],
			[() => Response.json({ refused: 'not_implemented' }, { status: 501 }), { kind: 'unavailable', reason: 'not_served' }],
			// A 501 that is not the object's own answer is no proof the release lacks the operation.
			[() => new Response('Not Implemented', { status: 501 }), { kind: 'unavailable', reason: 'unreachable' }],
			[() => new Response(null, { status: 302 }), { kind: 'unavailable', reason: 'invalid_answer' }],
		]
		for (const [answer, expected] of answers) {
			const { ops, sent } = await transport(answer, { keys: ['newest-key', 'previous-key'] })
			expect(await ops.state(TARGET, transition, signal)).toEqual(expected)
			expect(sent).toHaveLength(1)
		}
	})

	test('a metadata request refuses an answer that carries content', async () => {
		const { ops } = await transport(() => Response.json(contentView({ mode: 'open', generation: null, published: false })))
		expect(await ops.inspect(TARGET, { object: 'application', content: false }, signal)).toEqual({ kind: 'unavailable', reason: 'invalid_answer' })
	})

	test('an environment without a domain has no channel, and nothing is sent', async () => {
		const { ops, sent } = await transport(ack, { domain: null })
		expect(await ops.state(TARGET, transition, signal)).toEqual({ kind: 'unavailable', reason: 'no_channel' })
		expect(sent).toEqual([])
	})
})

describe('data RPC', () => {
	function fixture(provider: ControlProvider = fakeControlProvider) {
		const harness = createHarness()
		const repositories = harness.repositories
		const object = new FakeObject()
		const call = async (auth: AuthContext, method: string, input: unknown): Promise<{ status: number; body: unknown }> => {
			const deps: ControlRpcDeps & { opsTransport: OpsTransport } = {
				repositories,
				auth,
				queue: { send: () => Promise.resolve() },
				logs: { get: () => Promise.resolve(null) },
				provider,
				lock: new SqlDeployLocks(harness.d1),
				cancelRun: () => Promise.resolve(),
				opsTransport: object,
			}
			const response = await rpcResult(rpcRequest(method, input), deps)
			return { status: response.status, body: await response.json() }
		}
		const seed = async (): Promise<void> => {
			await repositories.registry.createApp({ id: APP, repoUrl: 'github.com/acme/crm' })
			await repositories.registry.upsertAppEnv(providerEnvironment(APP, ENV, { domain: 'crm.example.com' }))
		}
		/** Publish an access snapshot at framework `0.9.0`, on Postgres when `database` says so. */
		const publish = async (database?: 'postgres'): Promise<void> => {
			const snapshot = JSON.stringify({
				version: 1,
				contract: notesArtifact,
				migrations: [],
				...(database === undefined ? {} : { database }),
				checker: '0.9.0',
			})
			await harness.d1.prepare('UPDATE app_envs SET published_run_id = ?, published_snapshot_json = ? WHERE app_id = ? AND env = ?').bind(
				uuidv7(),
				snapshot,
				APP,
				ENV,
			).run()
		}
		return { object, call, seed, publish, repositories, lock: new SqlDeployLocks(harness.d1) }
	}

	const appGrant = (action: string) => ({ action, scope: { type: 'app', value: APP } })

	test('an app-scoped data.content.read grant never reads content; a global one does', async () => {
		const f = fixture()
		await f.seed()
		const owner = authWithPermissions([appGrant('data.read'), appGrant('data.content.read'), appGrant('data.manage')])
		const refused = await f.call(owner, 'data.content', TARGET)
		const operator = authWithActions(['data.content.read'])
		expect(refused).toEqual(await f.call(operator, 'data.content', { ...TARGET, env: 'missing' }))
		expect(refused.status).toBe(404)
		expect(f.object.sent).toEqual([])
		const content = await f.call(operator, 'data.content', TARGET)
		expect(content.status).toBe(200)
		expect(content.body).toMatchObject({ bootFailure: { message: 'tenant 7 broke the boot' } })
		expect(f.object.sent).toEqual([{ op: 'inspect', content: true }])
	})

	test('data.read never returns content fields', async () => {
		const f = fixture()
		await f.seed()
		const reader = authWithPermissions([appGrant('data.read'), appGrant('data.manage')])
		const view = await f.call(reader, 'data.view', TARGET)
		expect(view.status).toBe(200)
		expect(view.body).toMatchObject({ release: '0.9.0', bootFailure: { at: BOOT_FAILED_AT } })
		expect(JSON.stringify(view.body)).not.toContain('tenant 7')
		expect(f.object.sent).toEqual([{ op: 'inspect', content: false }])
		const started = await startMaintenance({ repositories: f.repositories, lock: f.lock, ops: f.object }, {
			...TARGET,
			mode: 'read-only',
			actor: 'user:test',
		})
		if (started.kind !== 'driven') throw new Error(`maintenance not driven: ${started.kind}`)
		expect(started.operation).toMatchObject({ kind: 'maintenance', state: 'succeeded', target_mode: 'read-only', generation: 1 })
		const listed = await f.call(reader, 'data.operations.list', TARGET)
		expect(listed.status).toBe(200)
		const got = await f.call(reader, 'data.operations.get', { operationId: started.operation.id })
		expect(listed.body).toEqual({ items: [got.body], nextCursor: null })
		expect(typeof got.body === 'object' && got.body !== null ? Object.keys(got.body).sort() : null).toEqual([
			'actor',
			'appId',
			'createdAt',
			'env',
			'errorCode',
			'finishedAt',
			'generation',
			'id',
			'kind',
			'recoversOperationId',
			'resolution',
			'runId',
			'state',
			'step',
			'targetMode',
			'updatedAt',
		])
	})

	test('a metadata answer that carries content is refused, never passed on', async () => {
		const f = fixture()
		await f.seed()
		f.object.inspect = () =>
			Promise.resolve({ kind: 'ok', value: { content: true, view: contentView({ mode: 'open', generation: null, published: false }) } })
		const view = await f.call(authWithActions(['data.read']), 'data.view', TARGET)
		expect(view.status).toBe(502)
		expect(JSON.stringify(view.body)).not.toContain('tenant 7')
	})

	test('data.start drives a maintenance operation and data.recover a recovery; a backup still answers 501', async () => {
		const f = fixture()
		await f.seed()
		const manager = authWithPermissions([appGrant('data.read'), appGrant('data.manage')])
		expect((await f.call(manager, 'data.start', { ...TARGET, kind: 'backup' })).status).toBe(501)
		expect(f.object.sent).toEqual([])

		f.object.behaviour = () => 'down'
		const stuck = await f.call(manager, 'data.start', { ...TARGET, kind: 'maintenance', mode: 'read-only' })
		expect(stuck).toMatchObject({ status: 200, body: { kind: 'maintenance', state: 'running', step: 'restrict', generation: 1 } })
		const stuckId = typeof stuck.body === 'object' && stuck.body !== null ? Reflect.get(stuck.body, 'id') : null
		f.object.behaviour = () => 'answer'
		const recovered = await f.call(manager, 'data.recover', { ...TARGET, operationId: stuckId, resolution: 'open' })
		expect(recovered).toMatchObject({ status: 200, body: { kind: 'recovery', state: 'succeeded', targetMode: 'open' } })
		expect(f.object.published).toEqual({ generation: 3, mode: 'open' })
		expect(await recordedMaintenance({ repositories: f.repositories }, TARGET)).toBe('open')
	})

	test('data.start on an object whose release does not serve state answers the failed record, and the environment stays open', async () => {
		const f = fixture()
		await f.seed()
		f.object.behaviour = () => 'not_served'
		const manager = authWithPermissions([appGrant('data.read'), appGrant('data.manage')])
		const started = await f.call(manager, 'data.start', { ...TARGET, kind: 'maintenance', mode: 'read-only' })
		expect(started).toMatchObject({ status: 200, body: { state: 'failed', errorCode: 'not_served' } })
		expect(await recordedMaintenance({ repositories: f.repositories }, TARGET)).toBe('open')
	})

	test('inspect, maintenance, backup and restore on an environment its provider serves no ops answer not_served (409) before any request', async () => {
		// As the Cloudflare provider answers: an environment on Postgres has no ops channel and no data operations.
		const provider: ControlProvider = {
			...fakeControlProvider,
			opsChannel: (access) => access.database === undefined,
			dataOperations: (access) => access.database === undefined,
		}
		const f = fixture(provider)
		await f.seed()
		await f.publish('postgres')
		const manager = authWithPermissions([appGrant('data.read'), appGrant('data.manage')])
		const notServed = {
			status: 409,
			body: expect.objectContaining({
				error:
					'the environment does not serve this operation: deploy it at a release that does, unless it runs on Postgres, whose data its database provider keeps',
			}),
		}
		expect(await f.call(manager, 'data.view', TARGET)).toEqual(notServed)
		expect(await f.call(authWithActions(['data.content.read']), 'data.content', TARGET)).toEqual(notServed)
		expect(await f.call(manager, 'data.start', { ...TARGET, kind: 'maintenance', mode: 'read-only' })).toEqual(notServed)
		expect(await f.call(manager, 'data.start', { ...TARGET, kind: 'backup' })).toEqual(notServed)
		expect(await f.call(manager, 'data.start', { ...TARGET, kind: 'restore', at: '2026-01-01T00:00:00.000Z' })).toEqual(notServed)
		expect(f.object.sent).toEqual([])
		expect(await f.repositories.dataOperations.listForEnvironment(APP, ENV, { limit: 1 })).toEqual([])

		// The same environment on the object's SQLite is served, as it was.
		await f.publish()
		expect((await f.call(manager, 'data.view', TARGET)).status).toBe(200)
		expect(f.object.sent).toEqual([{ op: 'inspect', content: false }])
	})

	test('an environment the caller may not act on is the same 404 as one that does not exist', async () => {
		const f = fixture()
		await f.seed()
		const stranger = authWithPermissions([{ action: 'data.read', scope: { type: 'app', value: 'other' } }, {
			action: 'data.manage',
			scope: { type: 'app', value: 'other' },
		}])
		for (
			const [method, input] of [
				['data.view', TARGET],
				['data.operations.list', TARGET],
				['data.start', { ...TARGET, kind: 'maintenance', mode: 'closed' }],
				['data.recover', { ...TARGET, operationId: uuidv7(), resolution: 'open' }],
			] as const
		) {
			expect((await f.call(stranger, method, input)).status).toBe(404)
			expect((await f.call(authWithActions(['data.read', 'data.manage']), method, { ...input, env: 'missing' })).status).toBe(404)
		}
		const reader = authWithPermissions([appGrant('data.read')])
		expect((await f.call(reader, 'data.start', { ...TARGET, kind: 'maintenance', mode: 'closed' })).status).toBe(404)
		expect(f.object.sent).toEqual([])
	})
})
