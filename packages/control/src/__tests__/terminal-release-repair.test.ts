import {
	operationsReleaseName,
	type OperationsReleaseProjectionPayloadV1,
	type OperationsReleaseReconcileRequestV1,
	parseOperationsReleasePayload,
	parseOperationsReleaseRequest,
} from '@fabrika/operations-contract/releases'
import { type SqlDatabase, SqlDeployLocks, type SqlQueryResult, type SqlRunResult, type SqlStatement } from '@fabrika/platform'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories, OperationsReleaseRepository } from '../db'
import { TERMINAL_RELEASE_REPAIR_DIAGNOSTIC } from '../db/operations-releases'
import { LEASE_TTL_MS } from '../lease'
import { type OperationsReleaseProjectionDeps, replayOperationsReleases } from '../operations-releases'
import { reconcileProviderRuns, sweepStaleRuns } from '../provider-reconcile'
import { cancelDeploy, executeDeploy } from '../run-lifecycle'
import { EnvSecretResolver } from '../secret-resolver'
import { createHarness } from './helpers/harness'
import { fixtureRuns } from './helpers/lock'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider, providerEnvironment } from './helpers/provider'

const NOW_S = 1_700_000_000
const NOW_MS = NOW_S * 1_000
const COMMIT = 'a'.repeat(40)
const SYNC_KEY = 'terminal-release-sync-key-with-32-bytes'

class QueryBudgetStatement implements SqlStatement {
	constructor(readonly inner: SqlStatement, private readonly count: () => void) {}

	bind(...values: unknown[]): SqlStatement {
		return new QueryBudgetStatement(this.inner.bind(...values), this.count)
	}

	first<T = Record<string, unknown>>(): Promise<T | null> {
		this.count()
		return this.inner.first<T>()
	}

	all<T = Record<string, unknown>>(): Promise<SqlQueryResult<T>> {
		this.count()
		return this.inner.all<T>()
	}

	run(): Promise<SqlRunResult> {
		this.count()
		return this.inner.run()
	}
}

class QueryBudgetDatabase implements SqlDatabase {
	calls = 0

	constructor(private readonly inner: SqlDatabase) {}

	private count(amount = 1): void {
		this.calls += amount
		if (this.calls > 10_000) throw new Error('test database query budget exhausted')
	}

	prepare(sql: string): SqlStatement {
		return new QueryBudgetStatement(this.inner.prepare(sql), () => this.count())
	}

	batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]> {
		this.count(statements.length)
		return this.inner.batch<T>(statements.map((statement) => {
			if (!(statement instanceof QueryBudgetStatement)) throw new Error('statement belongs to another test database')
			return statement.inner
		}))
	}
}

function frozen(runId: string): OperationsReleaseProjectionPayloadV1 {
	return {
		runId,
		coordinate: { appId: 'notes', environment: 'prod' },
		phase: 'started',
		providerRunId: null,
		outcome: null,
		artifactState: 'pending',
		release: {
			kind: 'available',
			name: operationsReleaseName({ appId: 'notes', environment: 'prod', commitSha: COMMIT }),
			commitSha: COMMIT,
		},
		uploadCredential: { verifier: 'b'.repeat(64), expiresAt: NOW_MS + 7_200_000 },
		observedAt: NOW_MS,
	}
}

if (!hasPostgres) console.warn(`terminal-release-repair.test.ts ${skipReason}`)

for (const backend of ['sqlite', 'postgres']) {
	describe.skipIf(backend === 'postgres' && !hasPostgres)(`existing-context terminal repair — ${backend}`, () => {
		let database: SqlDatabase
		let repositories: ControlRepositories
		let lock: SqlDeployLocks
		let owned: ReturnType<typeof fixtureRuns>
		let deps: OperationsReleaseProjectionDeps
		let close: () => Promise<void>
		let requests: OperationsReleaseReconcileRequestV1[]
		let transportAvailable: boolean

		/** The row turns authoritative `failed` after the projection recorded `succeeded`. */
		const failSucceededRun = async (runId: string): Promise<void> => {
			await database.prepare(`UPDATE runs SET status = 'failed', exit_code = NULL WHERE id = ? AND status = 'succeeded'`).bind(runId).run()
		}

		beforeEach(async () => {
			if (backend === 'postgres') {
				const fixture = await createPostgres('terminal_release')
				database = fixture.db
				repositories = createControlRepositories(database, { now: () => NOW_S + 10 })
				close = fixture.close
			} else {
				const harness = createHarness(() => NOW_S + 10)
				database = harness.d1
				repositories = harness.repositories
				close = () => {
					harness.sqlite.close()
					return Promise.resolve()
				}
			}
			lock = new SqlDeployLocks(database)
			owned = fixtureRuns(repositories.runs, lock)
			requests = []
			transportAvailable = true
			deps = {
				repository: repositories.operationsReleases,
				terminalRepair: { runs: repositories.runs },
				syncKey: SYNC_KEY,
				// Repair runs years later; this clock must not replace the historical observation.
				now: () => NOW_MS + 100_000_000_000,
				service: {
					async fetch(request) {
						expect(await lock.acquire('notes:prod', 'http-witness', LEASE_TTL_MS)).toBe(true)
						await lock.release('notes:prod', 'http-witness')
						if (!transportAvailable) return new Response(null, { status: 503 })
						const decoded: unknown = await request.json()
						const payload = parseOperationsReleaseRequest(decoded)
						requests.push(payload)
						return Response.json({ protocolVersion: 1, revision: payload.revision, outcome: 'applied' })
					},
				},
			}
			await repositories.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
			await repositories.registry.upsertAppEnv(providerEnvironment('notes', 'prod'))
		})

		afterEach(async () => close())

		async function seed(runId: string, payload: unknown = frozen(runId), clean = false): Promise<void> {
			await repositories.runs.createRun({ id: runId, appId: 'notes', env: 'prod', ref: 'main', commitSha: COMMIT, trigger: 'manual' })
			await repositories.operationsReleases.project(runId, JSON.stringify(payload))
			if (clean) await repositories.operationsReleases.markApplied(runId, 1)
		}

		async function stored(runId: string): Promise<OperationsReleaseProjectionPayloadV1> {
			const row = await repositories.operationsReleases.get(runId)
			if (row === null) throw new Error('expected frozen context')
			const decoded: unknown = JSON.parse(row.payload_json)
			return parseOperationsReleasePayload(decoded)
		}

		test('repairs clean and dirty started and accepted rows before sending terminal data', async () => {
			for (const clean of [true, false]) {
				for (const phase of ['started', 'provider_accepted']) {
					const runId = `${phase}-${clean}`
					await seed(runId, { ...frozen(runId), phase }, clean)
					await owned.start(runId, 'logs')
					await owned.externalId(runId, `external-${runId}`)
					await owned.finish(runId, 'succeeded', 0)
				}
			}
			expect(await replayOperationsReleases(deps)).toEqual({ applied: 4, failed: 0, pending: 0 })
			expect(requests).toHaveLength(4)
			for (const request of requests) {
				expect(request).toMatchObject({ phase: 'terminal', outcome: 'succeeded', artifactState: 'incomplete', revision: 2 })
				expect(request.providerRunId).toBe(`external-${request.runId}`)
				expect(request.observedAt).toBe(NOW_MS + 10_000)
				expect(request.uploadCredential).toEqual(frozen(request.runId).uploadCredential)
				expect(request.coordinate).not.toHaveProperty('serviceKey')
			}
		})

		test('2500 retained matching releases fit the database budget and leave pending delivery and leases healthy', async () => {
			for (let index = 0; index < 2500; index++) {
				const runId = `retained-${String(index).padStart(4, '0')}`
				await seed(runId, { ...frozen(runId), phase: 'terminal', outcome: 'succeeded', artifactState: 'complete' }, true)
				await owned.finish(runId, 'succeeded', 0)
			}
			await seed('z-pending')
			const budget = new QueryBudgetDatabase(database)
			const counted = createControlRepositories(budget)
			const delivered: OperationsReleaseReconcileRequestV1[] = []
			expect(
				await replayOperationsReleases({
					repository: counted.operationsReleases,
					terminalRepair: { runs: counted.runs },
					syncKey: SYNC_KEY,
					service: {
						async fetch(request) {
							const decoded: unknown = await request.json()
							const payload = parseOperationsReleaseRequest(decoded)
							delivered.push(payload)
							return Response.json({ protocolVersion: 1, revision: payload.revision, outcome: 'applied' })
						},
					},
				}),
			).toEqual({ applied: 1, failed: 0, pending: 0 })
			expect(budget.calls).toBeLessThanOrEqual(10_000)
			expect(delivered.map((request) => request.runId)).toEqual(['z-pending'])
			expect(Number((await repositories.operationsReleases.get('z-pending'))?.applied_revision)).toBe(1)
			expect((await database.prepare('SELECT lock_key FROM deploy_locks').all<{ lock_key: string }>()).results).toEqual([])
			expect(await lock.acquire('notes:prod', 'after-budget-pass', LEASE_TTL_MS)).toBe(true)
			await lock.release('notes:prod', 'after-budget-pass')
			console.info(`terminal release retained-row query witness (${backend}): ${budget.calls} calls`)
		}, 30_000)

		test('a matching discovery snapshot changed after scanning is skipped and repaired on the next pass', async () => {
			await seed('snapshot-change', { ...frozen('snapshot-change'), phase: 'terminal', outcome: 'succeeded' }, true)
			await owned.finish('snapshot-change', 'succeeded', 0)
			let changed = false
			class ChangeAfterDiscovery extends OperationsReleaseRepository {
				override async listTerminalPage(...args: Parameters<OperationsReleaseRepository['listTerminalPage']>) {
					const page = await super.listTerminalPage(...args)
					if (!changed && page.some((row) => row.run_id === 'snapshot-change')) {
						changed = true
						await failSucceededRun('snapshot-change')
					}
					return page
				}
			}
			const replayDeps = { ...deps, repository: new ChangeAfterDiscovery(database) }
			await replayOperationsReleases(replayDeps)
			expect(Number((await repositories.operationsReleases.get('snapshot-change'))?.desired_revision)).toBe(1)
			expect(requests).toEqual([])
			await replayOperationsReleases(replayDeps)
			expect(requests[0]).toMatchObject({ phase: 'terminal', outcome: 'failed', revision: 2 })
		})

		test('malformed matching terminal snapshots record a repair diagnostic', async () => {
			const cases = [
				{ ...frozen('matching-invalid-0'), runId: 'other' },
				{ ...frozen('matching-invalid-1'), coordinate: { appId: 'other', environment: 'prod' } },
				{ ...frozen('matching-invalid-2'), release: { kind: 'available', name: 'wrong', commitSha: COMMIT } },
				{ ...frozen('matching-invalid-3'), uploadCredential: { verifier: 'b'.repeat(64), expiresAt: NOW_MS } },
			]
			for (const [index, payload] of cases.entries()) {
				const runId = `matching-invalid-${index}`
				await seed(runId, { ...payload, phase: 'terminal', outcome: 'succeeded' }, true)
				await owned.finish(runId, 'succeeded', 0)
			}
			await replayOperationsReleases(deps)
			for (const [index, payload] of cases.entries()) {
				expect(await repositories.operationsReleases.get(`matching-invalid-${index}`)).toMatchObject({
					desired_revision: 1,
					payload_json: JSON.stringify({ ...payload, phase: 'terminal', outcome: 'succeeded' }),
					last_error: TERMINAL_RELEASE_REPAIR_DIAGNOSTIC,
				})
			}
		})

		test('a run settled under the invocation suppresses its terminal projection, and repair sends it later', async () => {
			await repositories.runs.createRun({ id: 'runner', appId: 'notes', env: 'prod', ref: 'main', commitSha: COMMIT, trigger: 'manual' })
			const operations = { repository: repositories.operationsReleases, now: () => NOW_MS + 10_000 }
			// The terminal write is refused because the row is already settled: the invocation projects nothing.
			expect(
				await executeDeploy({
					repositories,
					lock,
					logs: { put: async () => {} },
					secrets: new EnvSecretResolver({}),
					operations,
					provider: {
						...fakeControlProvider,
						deploy: async (input) => {
							await input.events.externalId('runner-operation')
							await database.prepare(`UPDATE runs SET status = 'succeeded', exit_code = 0, finished_at = ?
							WHERE id = ? AND status IN ('pending','running') AND cancel_requested_at IS NULL`).bind(NOW_S + 10, input.runId).run()
							return { state: 'succeeded' }
						},
					},
				}, { runId: 'runner' }),
			).toEqual({ runId: 'runner', status: 'skipped' })
			expect((await stored('runner')).phase).toBe('provider_accepted')
			expect(await replayOperationsReleases(deps)).toEqual({ applied: 1, failed: 0, pending: 0 })
			expect(requests[0]).toMatchObject({ phase: 'terminal', outcome: 'succeeded', providerRunId: 'runner-operation', revision: 3 })
		})

		test('recovers a failed terminal outbox write and repeated overlapping replay adds one revision', async () => {
			class RejectTerminalProjection extends OperationsReleaseRepository {
				override project(runId: string, payloadJson: string): Promise<number> {
					const decoded: unknown = JSON.parse(payloadJson)
					if (parseOperationsReleasePayload(decoded).phase === 'terminal') return Promise.reject(new Error('write unavailable'))
					return super.project(runId, payloadJson)
				}
			}
			await repositories.runs.createRun({ id: 'lost-write', appId: 'notes', env: 'prod', ref: 'main', commitSha: COMMIT, trigger: 'manual' })
			expect(
				(await executeDeploy({
					repositories,
					lock,
					logs: { put: async () => {} },
					secrets: new EnvSecretResolver({}),
					provider: fakeControlProvider,
					operations: { repository: new RejectTerminalProjection(database), now: () => NOW_MS + 10_000 },
				}, { runId: 'lost-write' })).status,
			).toBe('succeeded')
			expect((await stored('lost-write')).phase).toBe('started')
			await Promise.all([replayOperationsReleases(deps), replayOperationsReleases(deps)])
			await replayOperationsReleases(deps)
			expect(Number((await repositories.operationsReleases.get('lost-write'))?.desired_revision)).toBe(2)
			expect((await stored('lost-write')).outcome).toBe('succeeded')
		})

		test('corrects succeeded to authoritative failed while preserving known artifact results and frozen identity', async () => {
			const payload: OperationsReleaseProjectionPayloadV1 = {
				...frozen('corrected'),
				phase: 'terminal',
				outcome: 'succeeded',
				artifactState: 'complete',
				observedAt: NOW_MS + 20_000,
			}
			await seed('corrected', payload, true)
			await owned.finish('corrected', 'succeeded', 0)
			await failSucceededRun('corrected')
			await repositories.registry.upsertAppEnv(
				providerEnvironment('notes', 'prod', { domain: 'changed.example', publicOrigin: 'https://changed.example' }),
			)
			await replayOperationsReleases({ ...deps, syncKey: 'rotated-key-that-also-has-at-least-32-bytes', artifactOrigin: 'https://new.example' })
			expect(await stored('corrected')).toEqual({ ...payload, outcome: 'failed' })
			expect(requests[0]?.revision).toBe(2)
			await replayOperationsReleases(deps)
			expect(Number((await repositories.operationsReleases.get('corrected'))?.desired_revision)).toBe(2)
		})

		test('preserves explicit service identity, credential omission and known non-pending artifact results', async () => {
			for (const artifactState of ['complete', 'incomplete', 'not_applicable']) {
				const runId = `artifact-${artifactState}`
				await seed(runId, {
					...frozen(runId),
					coordinate: { appId: 'notes', environment: 'prod', serviceKey: 'api' },
					release: {
						kind: 'available',
						name: operationsReleaseName({ appId: 'notes', environment: 'prod', serviceKey: 'api', commitSha: COMMIT }),
						commitSha: COMMIT,
					},
					uploadCredential: undefined,
					artifactState,
				})
				await owned.finish(runId, 'succeeded', 0)
			}
			await seed('missing-commit', {
				...frozen('missing-commit'),
				release: { kind: 'unavailable', reason: 'missing_commit' },
				uploadCredential: undefined,
			})
			await owned.finish('missing-commit', 'failed', null)
			await replayOperationsReleases(deps)
			for (const request of requests) {
				expect(request).not.toHaveProperty('uploadCredential')
				if (request.runId === 'missing-commit') {
					expect(request.release).toEqual({ kind: 'unavailable', reason: 'missing_commit' })
					expect(request.artifactState).toBe('not_applicable')
				} else {
					expect(request.runId).toBe(`artifact-${request.artifactState}`)
					expect(request.coordinate.serviceKey).toBe('api')
				}
			}
			expect(requests).toHaveLength(4)
		})

		test('refetches frozen context before repairing instead of repairing the discovery snapshot', async () => {
			await seed('refetch', frozen('refetch'), true)
			await owned.finish('refetch', 'succeeded', 0)
			const fresh: OperationsReleaseProjectionPayloadV1 = { ...frozen('refetch'), artifactState: 'complete', observedAt: NOW_MS + 20_000 }
			class ChangeAfterDiscovery extends OperationsReleaseRepository {
				override async listTerminalPage(...args: Parameters<OperationsReleaseRepository['listTerminalPage']>) {
					const page = await super.listTerminalPage(...args)
					if (page.some((row) => row.run_id === 'refetch')) await repositories.operationsReleases.project('refetch', JSON.stringify(fresh))
					return page
				}
			}
			await replayOperationsReleases({ ...deps, repository: new ChangeAfterDiscovery(database) })
			expect(await stored('refetch')).toEqual({ ...fresh, phase: 'terminal', outcome: 'succeeded' })
			expect(requests[0]?.revision).toBe(3)
		})

		test('captures an upper boundary so a newly appended terminal row waits for the next repair pass', async () => {
			await seed('a-boundary', frozen('a-boundary'), true)
			await owned.finish('a-boundary', 'succeeded', 0)
			let appended = false
			class AppendAfterBoundary extends OperationsReleaseRepository {
				override async listTerminalPage(...args: Parameters<OperationsReleaseRepository['listTerminalPage']>) {
					const page = await super.listTerminalPage(...args)
					if (!appended) {
						appended = true
						await seed('z-appended', frozen('z-appended'), true)
						await owned.finish('z-appended', 'failed', null)
					}
					return page
				}
			}
			await replayOperationsReleases({ ...deps, repository: new AppendAfterBoundary(database) })
			expect(Number((await repositories.operationsReleases.get('a-boundary'))?.desired_revision)).toBe(2)
			expect(Number((await repositories.operationsReleases.get('z-appended'))?.desired_revision)).toBe(1)
			await replayOperationsReleases(deps)
			expect(Number((await repositories.operationsReleases.get('z-appended'))?.desired_revision)).toBe(2)
		})

		test('a repair write failure does not stop delivery of a valid peer', async () => {
			class RejectOneRepair extends OperationsReleaseRepository {
				override repairTerminal(...args: Parameters<OperationsReleaseRepository['repairTerminal']>): Promise<boolean> {
					if (args[0].run_id === 'a-repair-fails') return Promise.reject(new Error('repair unavailable'))
					return super.repairTerminal(...args)
				}
			}
			for (const runId of ['a-repair-fails', 'z-repaired']) {
				await seed(runId)
				await owned.finish(runId, 'succeeded', 0)
			}
			expect(await replayOperationsReleases({ ...deps, repository: new RejectOneRepair(database) })).toEqual({ applied: 1, failed: 1, pending: 1 })
			expect(requests.map((request) => request.runId)).toEqual(['z-repaired'])
			expect(Number((await repositories.operationsReleases.get('a-repair-fails'))?.desired_revision)).toBe(1)
		})

		test('settled cancellation and stale sweep retain and repair existing context', async () => {
			await seed('cancelled', { ...frozen('cancelled'), phase: 'provider_accepted', providerRunId: 'operation' }, true)
			await owned.start('cancelled', 'logs')
			await owned.externalId('cancelled', 'operation')
			const run = await repositories.runs.getRun('cancelled')
			if (run === null) throw new Error('expected cancellable run')
			await cancelDeploy({ repositories, lock, provider: { ...fakeControlProvider, cancel: async () => ({ state: 'settled' }) } }, run)
			await seed('swept', { ...frozen('swept'), release: { kind: 'unavailable', reason: 'dry_run' }, uploadCredential: undefined }, true)
			await database.prepare('UPDATE runs SET created_at = ? WHERE id = ?').bind(NOW_S - 3600, 'swept').run()
			expect(await sweepStaleRuns({ repositories, lock }, 1800, () => NOW_S + 10)).toBe(1)
			expect(await replayOperationsReleases(deps)).toEqual({ applied: 2, failed: 0, pending: 0 })
			expect(requests.find((request) => request.runId === 'cancelled')).toMatchObject({ outcome: 'failed', providerRunId: 'operation' })
			expect(requests.find((request) => request.runId === 'swept')).toMatchObject({ outcome: 'failed', artifactState: 'not_applicable' })
			expect(await stored('swept')).not.toHaveProperty('uploadCredential')
		})

		test('repairs cancellation arriving during reconciliation after that branch omits projection', async () => {
			await seed('reconcile-cancel', frozen('reconcile-cancel'), true)
			await owned.start('reconcile-cancel', 'logs')
			await owned.externalId('reconcile-cancel', 'operation')
			expect(
				await reconcileProviderRuns({
					repositories,
					lock,
					provider: {
						...fakeControlProvider,
						cancel: async () => ({ state: 'settled' }),
						reconcile: async () => {
							await repositories.runs.requestRunCancellation('reconcile-cancel')
							return { state: 'succeeded' }
						},
					},
				}),
			).toMatchObject({ failed: 1 })
			expect((await stored('reconcile-cancel')).phase).toBe('started')
			await replayOperationsReleases(deps)
			expect(requests[0]).toMatchObject({ outcome: 'failed', revision: 2 })
		})

		test('repairs a terminal row without its environment lease and keeps it pending through an HTTP failure', async () => {
			await seed('contended', frozen('contended'), false)
			await owned.finish('contended', 'succeeded', 0)
			transportAvailable = false
			expect(await replayOperationsReleases(deps)).toEqual({ applied: 0, failed: 1, pending: 1 })
			expect(Number((await repositories.operationsReleases.get('contended'))?.desired_revision)).toBe(2)
			transportAvailable = true
			expect(await replayOperationsReleases(deps)).toEqual({ applied: 1, failed: 0, pending: 0 })
			expect(requests[0]?.revision).toBe(2)
			expect((await database.prepare('SELECT lock_key FROM deploy_locks').all<{ lock_key: string }>()).results).toEqual([])
		})

		test('finishes the captured keyset range past 100 correct and malformed rows without starving later repair', async () => {
			for (let index = 0; index < 205; index++) {
				const runId = `page-${String(index).padStart(3, '0')}`
				const payload = index < 102
					? { ...frozen(runId), phase: 'terminal', outcome: 'succeeded', artifactState: 'complete' }
					: index < 204
					? { malformed: true }
					: frozen(runId)
				await seed(runId, payload, true)
				await owned.finish(runId, 'succeeded', 0)
			}
			expect(await replayOperationsReleases(deps)).toEqual({ applied: 1, failed: 0, pending: 0 })
			expect(requests[0]?.runId).toBe('page-204')
			expect(Number((await repositories.operationsReleases.get('page-204'))?.desired_revision)).toBe(2)
			expect((await repositories.operationsReleases.get('page-203'))?.last_error).toBe(TERMINAL_RELEASE_REPAIR_DIAGNOSTIC)
			expect(Number((await repositories.operationsReleases.get('page-101'))?.desired_revision)).toBe(1)
		})

		test('invalid identity, insufficient finish evidence and derived expiry conflicts preserve bytes and revision', async () => {
			const cases = [
				{ ...frozen('invalid-0'), runId: 'other' },
				{ ...frozen('invalid-1'), coordinate: { appId: 'other', environment: 'prod' } },
				{ ...frozen('invalid-2'), release: { kind: 'available', name: 'wrong', commitSha: COMMIT } },
				{ ...frozen('invalid-3'), uploadCredential: { verifier: 'b'.repeat(64), expiresAt: NOW_MS + 10_000 } },
				frozen('invalid-4'),
				{ ...frozen('invalid-5'), uploadCredential: { verifier: 'b'.repeat(64), expiresAt: NOW_MS } },
				{ ...frozen('invalid-6'), phase: 'terminal', outcome: 'failed' },
			]
			for (const [index, payload] of cases.entries()) {
				const runId = `invalid-${index}`
				await seed(runId, payload, index % 2 === 0)
				await owned.finish(runId, 'succeeded', 0)
				if (index === 4) await database.prepare('UPDATE runs SET finished_at = NULL WHERE id = ?').bind(runId).run()
			}
			await replayOperationsReleases(deps)
			for (const [index, payload] of cases.entries()) {
				const row = await repositories.operationsReleases.get(`invalid-${index}`)
				expect(row?.payload_json).toBe(JSON.stringify(payload))
				expect(Number(row?.desired_revision)).toBe(1)
				expect(row?.last_error).toBe(TERMINAL_RELEASE_REPAIR_DIAGNOSTIC)
			}
			expect(requests).toEqual([])
		})
	})
}
