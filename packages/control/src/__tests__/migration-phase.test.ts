// A deploy that brings an application migration the environment's object has not applied runs as one `migrate` data
// operation under the run's lease (ADR-0069 §3, ADR-0070 §8): read-only, the backup, its rehearsal, the deploy, the
// migration request, then open. Against the fake ops environment and a provider double, with the real SQL lease and
// records on SQLite always and on Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import { type BlobStore, type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import type { ControlProvider, ProviderDeployOutcome } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { runBackupSchedule } from '../backups'
import {
	DEPLOY_FAILED_CODE,
	MIGRATION_FAILED_CODE,
	type OpsTarget,
	recordedMaintenance,
	REHEARSAL_FAILED_CODE,
	startRecovery,
} from '../data-operations'
import { type ControlRepositories, createControlRepositories } from '../db'
import { runLeaseKey } from '../lease'
import { VaultOpsKeys } from '../ops-key'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { memoryCommits } from './helpers/commits'
import { healthOnly } from './helpers/contracts'
import { createHarness } from './helpers/harness'
import { fixtureProtect } from './helpers/lock'
import { FakeEnvironments } from './helpers/ops-environments'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'
import { createTestVault } from './helpers/vault'

if (!hasPostgres) console.warn(`migration-phase.test.ts Postgres half ${skipReason}`)

const APP = 'crm'
const ENV = 'prod'
const TARGET: OpsTarget = { appId: APP, env: ENV }
const KEY = runLeaseKey(APP, ENV)
const FIRST = '20261025000000_notes.sql'
const SECOND = '20261026000000_note_tags.sql'
const THIRD = '20261027000000_note_links.sql'
/** The health path of the contract an older release deploys, by which the provider double tells its access apart. */
const OLDER_HEALTH = '/healthz-older'

const vault = await createTestVault()

/** The commit a run deploys: the contract, an older release's when `older`, and these application migrations. */
function tree(migrations: readonly string[], older = false): Record<string, string> {
	const contract = older ? healthOnly(APP).replace("'/healthz'", `'${OLDER_HEALTH}'`) : healthOnly(APP)
	const files: Record<string, string> = { 'fabrika.contract.ts': contract }
	for (const name of migrations) files[`db/migrations/${name}`] = `CREATE TABLE t_${name.slice(15, -4)} (id TEXT PRIMARY KEY);`
	return files
}

/** Every request a whole pre-migration backup of three parts sends at generation `g`: the dump and its rehearsal. */
function backupAndRehearsal(g: number): string[] {
	return [
		`state application read-only @${g}`,
		`export begin @${g}`,
		`export part 1 @${g}`,
		`export part 2 @${g}`,
		`export part 3 @${g}`,
		`export complete @${g}`,
		`state rehearsal inspect @${g}`,
		`import begin @${g}`,
		`import part 1 @${g}`,
		`import part 2 @${g}`,
		`import part 3 @${g}`,
		`import link 2 @${g}`,
		`import verify @${g}`,
		`import verify @${g}`,
		`import discard @${g}`,
	]
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
			const fixture = await createPostgres('migration_phase')
			return { repositories: createControlRepositories(fixture.db), db: fixture.db, close: () => fixture.close() }
		},
	},
]

for (const backend of backends) {
	describe.skipIf(backend.skip)(`the migration phase (${backend.name})`, () => {
		let opened: Backend | null = null

		afterEach(async () => {
			await opened?.close()
			opened = null
		})

		async function open(options: { domain?: string | null } = {}) {
			const b = await backend.open()
			opened = b
			await b.repositories.registry.createApp({ id: APP, repoUrl: 'github.com/acme/crm' })
			await b.repositories.registry.upsertAppEnv(
				providerEnvironment(APP, ENV, { domain: options.domain === undefined ? 'crm.example.com' : options.domain }),
			)
			const locks = new SqlDeployLocks(b.db)
			await fixtureProtect(b.repositories.registry, locks, TARGET, false)
			const fake = new FakeEnvironments()
			const logs = new Map<string, string>()
			const store: BlobStore = {
				put: (key, value) => {
					if (typeof value !== 'string') throw new Error('test log store accepts strings only')
					logs.set(key, value)
					return Promise.resolve()
				},
				get: (key) => {
					const value = logs.get(key)
					return Promise.resolve(value === undefined ? null : { body: new Blob([value]).stream(), text: () => Promise.resolve(value) })
				},
				delete: (key) => {
					logs.delete(key)
					return Promise.resolve()
				},
			}
			/** The lease row's holder each time the object or the provider was reached, in order. */
			const holders: (string | null)[] = []
			const holder = async (): Promise<string | null> =>
				(await b.db.prepare('SELECT holder FROM deploy_locks WHERE lock_key = ?').bind(KEY).first<{ holder: string }>())?.holder ?? null
			fake.fault = async () => {
				holders.push(await holder())
				return undefined
			}
			const state = {
				serves: true,
				outcome: { state: 'succeeded' } as ProviderDeployOutcome,
				settlement: 'succeeded' as 'succeeded' | 'failed' | 'running',
				/** Where in the object's requests each deploy happened, and the migrations each one deployed. */
				deploys: [] as { at: number; migrations: string[] }[],
				reconciles: 0,
				migrations: [FIRST],
				/** The candidate is an older release, which the provider serves no ops channel at. */
				older: false,
				/** The provider refuses the deploy before accepting it. */
				refuses: false,
			}
			const provider: ControlProvider = {
				id: TEST_PROVIDER_ID,
				normalizeRegistration: (input) => input,
				source: { binding: 'connection' },
				resolveSource: () => Promise.resolve({ commitSha: 'a'.repeat(40) }),
				opsChannel: (access) => state.serves && !JSON.stringify(access.contract).includes(OLDER_HEALTH),
				deploy: async (input) => {
					holders.push(await holder())
					if (state.refuses) throw new Error('the provider refused the deploy')
					state.deploys.push({ at: fake.requests().length, migrations: [...state.migrations] })
					await input.events.externalId(`${input.runId}-external`)
					// The release now running bundles the deployed migrations; it applies them on a `migrate` request.
					fake.bundled = [...state.migrations]
					return state.outcome
				},
				reconcile: async () => {
					holders.push(await holder())
					state.reconciles++
					return { state: state.settlement }
				},
			}
			const deps = (): RunDeps => ({
				repositories: b.repositories,
				lock: locks,
				secrets: new VaultSecretResolver({}),
				provider,
				logs: store,
				runLogs: store,
				commits: memoryCommits(tree(state.migrations, state.older)),
				opsKeys: new VaultOpsKeys(b.repositories.opsKeys, () => Promise.resolve(vault)),
				ops: fake,
			})
			const run = async (): Promise<string> => {
				const id = uuidv7()
				await b.repositories.runs.createRun({ id, appId: APP, env: ENV, ref: 'main', trigger: 'manual', actor: 'user:test' })
				return id
			}
			const log = (runId: string): string => logs.get(`runs/${runId}/logs.ndjson`) ?? ''
			/** The first deploy publishes `FIRST`, and the object, open, applies it on its cold start. */
			const deployFirst = async (): Promise<void> => {
				const first = await run()
				expect(await executeDeploy(deps(), { runId: first })).toEqual({ runId: first, status: 'succeeded' })
				fake.ledger = [{ bundle: 'app', name: FIRST, checksum: 'a'.repeat(64), appliedAt: '2027-01-14T08:00:00.000Z' }]
				fake.sent.length = 0
				holders.length = 0
			}
			/** The object's requests with each deploy in its place. */
			const timeline = (): string[] => {
				const requests = fake.requests()
				for (const deploy of [...state.deploys].reverse()) requests.splice(deploy.at, 0, 'deploy')
				return requests
			}
			const operations = async () => [...(await b.repositories.dataOperations.listForEnvironment(APP, ENV, { limit: 10 }))]
			const backups = async () => [...(await b.repositories.backups.listForEnvironment(APP, ENV, { limit: 10 }))]
			return { b, fake, state, deps, run, log, holders, deployFirst, timeline, operations, backups }
		}

		test('a deploy with a pending migration runs read-only, backup, verify, deploy, migrate and open under its own lease', async () => {
			const { b, fake, state, deps, run, log, holders, deployFirst, timeline, operations, backups } = await open()
			await deployFirst()
			state.deploys.length = 0
			state.migrations = [FIRST, SECOND]
			const second = await run()
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(timeline()).toEqual(['inspect', ...backupAndRehearsal(1), 'deploy', 'migrate @1', 'state application open @2'])
			expect(fake.ledger.map((row) => row.name)).toEqual([FIRST, SECOND])
			// One holder, the run's, from the first request to the last: the deploy ran under the operation's lease.
			expect(new Set(holders).size).toBe(1)
			expect(holders[0]).not.toBeNull()
			const [operation] = await operations()
			expect(operation).toMatchObject({
				kind: 'migrate',
				state: 'succeeded',
				step: 'open',
				target_mode: 'open',
				generation: 2,
				run_id: second,
				actor: 'user:test',
			})
			const [backup] = await backups()
			expect(backup).toMatchObject({ operation_id: operation?.id, pre_migration: 1, state: 'succeeded', rehearsal: 'passed' })
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
			expect((await b.repositories.runs.getRun(second))?.status).toBe('succeeded')
			expect(log(second)).toContain('1 application migration the environment has not applied')
			expect(log(second)).toContain(`data operation ${operation?.id} succeeded`)
			// The lease is released once the run settled.
			expect(await b.db.prepare('SELECT holder FROM deploy_locks WHERE lock_key = ?').bind(KEY).first()).toBeNull()
		})

		test('a failed rehearsal reopens the object and fails the run without deploying', async () => {
			const { b, fake, state, deps, run, log, deployFirst, timeline, operations, backups } = await open()
			await deployFirst()
			state.deploys.length = 0
			state.migrations = [FIRST, SECOND]
			fake.fault = (sent) => sent.op === 'import' && sent.step === 'verify' ? { refused: 'verify_mismatch', table: 't1' } : undefined
			const second = await run()
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'failed' })
			expect(state.deploys).toEqual([])
			expect(timeline().slice(-2)).toEqual(['import verify @1', 'state application open @2'])
			const [operation] = await operations()
			expect(operation).toMatchObject({ kind: 'migrate', state: 'failed', error_code: REHEARSAL_FAILED_CODE, step: 'open', generation: 2 })
			expect(await backups()).toMatchObject([{ pre_migration: 1, state: 'failed', rehearsal: 'failed', rehearsal_code: 'verify_mismatch' }])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
			expect(fake.ledger.map((row) => row.name)).toEqual([FIRST])
			expect(log(second)).toContain(`deploy not started: data operation ${operation?.id} failed at open (${REHEARSAL_FAILED_CODE})`)
		})

		test('a deploy the provider leaves running is settled under the same lease before the migration request', async () => {
			const { b, fake, state, deps, run, holders, deployFirst, timeline, operations } = await open()
			await deployFirst()
			state.deploys.length = 0
			state.migrations = [FIRST, SECOND]
			state.outcome = { state: 'running' }
			const second = await run()
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(state.reconciles).toBe(1)
			expect(timeline().slice(-3)).toEqual(['deploy', 'migrate @1', 'state application open @2'])
			expect(new Set(holders).size).toBe(1)
			expect(await operations()).toMatchObject([{ kind: 'migrate', state: 'succeeded', run_id: second }])
			expect((await b.repositories.runs.getRun(second))?.status).toBe('succeeded')
			expect(fake.ledger.map((row) => row.name)).toEqual([FIRST, SECOND])
		})

		test('a failed deploy leaves the object read-only and the operation failed, for an operator to recover', async () => {
			const { b, state, deps, run, deployFirst, timeline, operations } = await open()
			await deployFirst()
			state.deploys.length = 0
			state.migrations = [FIRST, SECOND]
			state.outcome = { state: 'failed' }
			const second = await run()
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'failed' })
			expect(timeline().at(-1)).toBe('deploy')
			expect(await operations()).toMatchObject([{ state: 'failed', error_code: DEPLOY_FAILED_CODE, step: 'deploy', target_mode: 'read-only' }])
			expect(await recordedMaintenance(b, TARGET)).toBe('unsettled')
		})

		test('a migration whose boot fails leaves the object read-only and the operation failed', async () => {
			const { b, fake, state, deps, run, log, deployFirst, operations } = await open()
			await deployFirst()
			state.migrations = [FIRST, SECOND]
			fake.bootFails = true
			const second = await run()
			// The version went live, so the run succeeded; the operation says the migration did not.
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			const [operation] = await operations()
			expect(operation).toMatchObject({ state: 'failed', error_code: MIGRATION_FAILED_CODE, step: 'migrate', target_mode: 'read-only' })
			expect(fake.requests().slice(-4)).toEqual(['migrate @1', 'migrate @1', 'migrate @1', 'inspect'])
			expect(await recordedMaintenance(b, TARGET)).toBe('unsettled')
			expect(log(second)).toContain(`data operation ${operation?.id} failed at migrate (${MIGRATION_FAILED_CODE})`)
		})

		test('the maintenance pass takes over a migration its run no longer drives, and leaves one whose lease is held', async () => {
			const { b, fake, state, deps, run, deployFirst, operations } = await open()
			await deployFirst()
			state.migrations = [FIRST, SECOND]
			fake.fault = (sent) => sent.op === 'migrate' ? 'down' : undefined
			const second = await run()
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			const [stuck] = await operations()
			expect(stuck).toMatchObject({ kind: 'migrate', state: 'running', step: 'migrate', generation: 1 })
			fake.fault = () => undefined
			fake.sent.length = 0
			const locks = new SqlDeployLocks(b.db)
			const pass = () => runBackupSchedule({ repositories: b.repositories, lock: locks, ops: fake, provider: deps().provider })
			// The lease's holder is whoever still drives the migration: the pass sends it nothing.
			expect(await locks.acquire(KEY, 'run-invocation', 60_000)).toBe(true)
			expect(await pass()).toMatchObject({ resumed: 1, succeeded: 0 })
			expect(fake.requests()).toEqual([])
			expect(await operations()).toMatchObject([{ id: stuck?.id, state: 'running', step: 'migrate' }])
			// A free lease means its holder died: the pass fences above it, migrates and opens.
			await locks.release(KEY, 'run-invocation')
			expect(await pass()).toMatchObject({ resumed: 1, succeeded: 1 })
			expect(fake.requests()).toEqual(['state application read-only @2', 'migrate @2', 'state application open @3'])
			expect(fake.ledger.map((row) => row.name)).toEqual([FIRST, SECOND])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('a migration left without an answer resumes through a recovery at a fenced generation', async () => {
			const { b, fake, state, deps, run, log, deployFirst, operations } = await open()
			await deployFirst()
			state.migrations = [FIRST, SECOND]
			fake.fault = (sent) => sent.op === 'migrate' ? 'down' : undefined
			const second = await run()
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			const [stuck] = await operations()
			expect(stuck).toMatchObject({ kind: 'migrate', state: 'running', step: 'migrate', target_mode: 'read-only', generation: 1 })
			expect(log(second)).toContain(`data operation ${stuck?.id} stopped at migrate without an answer`)
			expect(await recordedMaintenance(b, TARGET)).toBe('unsettled')
			fake.fault = () => undefined
			fake.sent.length = 0
			const recovery = await startRecovery(
				{ repositories: b.repositories, lock: new SqlDeployLocks(b.db), ops: fake },
				{ ...TARGET, operationId: stuck?.id ?? '', resolution: 'resume', actor: 'user:ops' },
			)
			expect(recovery).toMatchObject({ kind: 'driven', result: 'succeeded' })
			// The recovery fences in `closed`, the resumed migration fences in `read-only` above it, migrates there and opens.
			expect(fake.requests()).toEqual([
				'inspect',
				'state application closed @2',
				'state application read-only @3',
				'migrate @3',
				'state application open @4',
			])
			expect(fake.ledger.map((row) => row.name)).toEqual([FIRST, SECOND])
			expect(await b.repositories.dataOperations.get(stuck?.id ?? '')).toMatchObject({ state: 'succeeded', step: 'open', generation: 4 })
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('no pending migration, an older release or no domain: a plain deploy as before', async () => {
			const { b, fake, state, deps, run, deployFirst, operations } = await open()
			await deployFirst()
			// Every migration of the candidate is in the ledger.
			const same = await run()
			expect(await executeDeploy(deps(), { runId: same })).toEqual({ runId: same, status: 'succeeded' })
			expect(fake.requests()).toEqual(['inspect'])
			// An older release, of the candidate or of the version before it, is never inspected.
			fake.sent.length = 0
			state.migrations = [FIRST, SECOND]
			state.serves = false
			const older = await run()
			expect(await executeDeploy(deps(), { runId: older })).toEqual({ runId: older, status: 'succeeded' })
			expect(fake.requests()).toEqual([])
			expect(await operations()).toEqual([])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('the first deploy at a gated release is plain: the version before it served no ops channel', async () => {
			const { fake, state, deps, run, operations } = await open()
			state.migrations = [FIRST, SECOND]
			const first = await run()
			expect(await executeDeploy(deps(), { runId: first })).toEqual({ runId: first, status: 'succeeded' })
			expect(fake.requests()).toEqual([])
			expect(await operations()).toEqual([])
		})

		test('an environment without a domain deploys plain', async () => {
			const { fake, state, deps, run, operations } = await open({ domain: null })
			const first = await run()
			expect(await executeDeploy(deps(), { runId: first })).toEqual({ runId: first, status: 'succeeded' })
			state.migrations = [FIRST, SECOND]
			const second = await run()
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(fake.requests()).toEqual([])
			expect(state.deploys).toHaveLength(2)
			expect(await operations()).toEqual([])
		})

		test('a downgrade that published and then failed before the provider leaves the next migrating deploy guarded', async () => {
			const { b, fake, state, deps, run, deployFirst, timeline, operations } = await open()
			await deployFirst()
			// The older release's snapshot is published, but no provider accepted it: the object still runs the gated one.
			state.older = true
			state.refuses = true
			const downgrade = await run()
			expect(await executeDeploy(deps(), { runId: downgrade })).toEqual({ runId: downgrade, status: 'failed' })
			expect(fake.requests()).toEqual([])
			const published = await b.repositories.registry.getAppEnv(APP, ENV)
			expect(published?.published_run_id).toBe(downgrade)
			expect(published?.published_snapshot_json).toContain(OLDER_HEALTH)
			state.older = false
			state.refuses = false
			state.deploys.length = 0
			state.migrations = [FIRST, SECOND]
			const upgrade = await run()
			expect(await executeDeploy(deps(), { runId: upgrade })).toEqual({ runId: upgrade, status: 'succeeded' })
			expect(timeline()).toEqual(['inspect', ...backupAndRehearsal(1), 'deploy', 'migrate @1', 'state application open @2'])
			expect(await operations()).toMatchObject([{ kind: 'migrate', state: 'succeeded', run_id: upgrade }])
		})

		test('a domain added to a gated environment: the next migrating deploy is plain and installs the channel, the one after is guarded', async () => {
			const { b, fake, state, deps, run, timeline, operations } = await open({ domain: null })
			const first = await run()
			expect(await executeDeploy(deps(), { runId: first })).toEqual({ runId: first, status: 'succeeded' })
			await b.db.prepare('UPDATE app_envs SET domain = ? WHERE app_id = ? AND env = ?').bind('crm.example.com', APP, ENV).run()
			// The running version has no channel to answer `inspect`: the deploy is plain, and the object migrates on boot.
			state.migrations = [FIRST, SECOND]
			const plain = await run()
			expect(await executeDeploy(deps(), { runId: plain })).toEqual({ runId: plain, status: 'succeeded' })
			expect(fake.requests()).toEqual([])
			expect(await operations()).toEqual([])
			fake.ledger = [FIRST, SECOND].map((name) => ({ bundle: 'app', name, checksum: 'a'.repeat(64), appliedAt: '2027-01-14T08:00:00.000Z' }))
			state.deploys.length = 0
			state.migrations = [FIRST, SECOND, THIRD]
			const guarded = await run()
			expect(await executeDeploy(deps(), { runId: guarded })).toEqual({ runId: guarded, status: 'succeeded' })
			expect(timeline()).toEqual(['inspect', ...backupAndRehearsal(1), 'deploy', 'migrate @1', 'state application open @2'])
			expect(fake.ledger.map((row) => row.name)).toEqual([FIRST, SECOND, THIRD])
		})

		test('an installed channel whose object does not answer inspect gets no unguarded deploy, and the run says why', async () => {
			const { b, fake, state, deps, run, log, deployFirst, operations } = await open()
			await deployFirst()
			state.deploys.length = 0
			state.migrations = [FIRST, SECOND]
			fake.fault = (sent) => sent.op === 'inspect' ? 'down' : undefined
			const second = await run()
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'failed' })
			expect(state.deploys).toEqual([])
			expect(await operations()).toEqual([])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
			expect(log(second)).toContain('cannot tell whether a migration is pending (unreachable)')
		})
	})
}
