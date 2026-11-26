// A deploy whose candidate records the migration bookmark migrates without a read-only window (ADR-0069 §3): the
// operation's own deploy, then `migrate` at the published generation until the new version answers, and on its failure
// the rollback deploy of the last succeeded commit, or `closed` for an operator. Against the fake ops environment and a
// provider double that deploys each commit's migrations, with the real SQL lease and records on SQLite always and on
// Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import { type OpsMigrationFailureReason, sha256Hex } from '@fabrika/auth-core'
import { type BlobStore, type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { abortableWait, type ControlProvider, type ProviderDeployOutcome } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import { runBackupSchedule } from '../backups'
import {
	DEPLOY_NOT_STARTED_CODE,
	MIGRATION_FAILED_CODE,
	MIGRATION_REVERTED_CODE,
	MIGRATION_UNCONFIRMED_CODE,
	NEW_VERSION_DEADLINE_S,
	type OpsTarget,
	recordedMaintenance,
} from '../data-operations'
import { type ControlRepositories, createControlRepositories } from '../db'
import type { CommitSource } from '../github/source/commit-files'
import type { LeaseClock } from '../lease'
import { runLeaseKey } from '../lease'
import { VaultOpsKeys } from '../ops-key'
import { executeDeploy, operationDeploys, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { memoryCommits } from './helpers/commits'
import { healthOnly } from './helpers/contracts'
import { createHarness } from './helpers/harness'
import { fixtureProtect } from './helpers/lock'
import { FakeEnvironments } from './helpers/ops-environments'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'
import { createTestVault } from './helpers/vault'

if (!hasPostgres) console.warn(`migrating-deploy.test.ts Postgres half ${skipReason}`)

const APP = 'crm'
const ENV = 'prod'
const TARGET: OpsTarget = { appId: APP, env: ENV }
const KEY = runLeaseKey(APP, ENV)
const FIRST = '20261025000000_notes.sql'
const SECOND = '20261026000000_note_tags.sql'
/** A migration that deletes data: it drops the table `FIRST` creates. */
const DROPS = '20261028000000_drop_notes.sql'
/** The pause between two `migrate` requests while the old version answers (`NEW_VERSION_POLL_MS`). */
const POLL_MS = 10_000
/** How many `migrate` requests one wait sends before its deadline: one at once, then one per poll until it passes. */
const ASKS_TO_DEADLINE = (NEW_VERSION_DEADLINE_S * 1000) / POLL_MS + 1

const vault = await createTestVault()

/** The text of an application migration file, as the commit holds it. */
const migrationText = (name: string): string => name === DROPS ? 'DROP TABLE t_notes;' : `CREATE TABLE t_${name.slice(15, -4)} (id TEXT PRIMARY KEY);`

/** The commit a run deploys: the contract and these application migrations. */
function tree(migrations: readonly string[]): Record<string, string> {
	const files: Record<string, string> = { 'fabrika.contract.ts': healthOnly(APP) }
	for (const name of migrations) files[`db/migrations/${name}`] = migrationText(name)
	return files
}

/** What the provider double does, and what it saw. */
interface ProviderState {
	/** The candidate's migrations: a run that resolves no recorded commit deploys these. */
	migrations: string[]
	/** The candidate's release records the migration bookmark. */
	bookmark: boolean
	/** Why the candidate's migrating boot fails, if it does. */
	failure: OpsMigrationFailureReason | null
	/** How many `migrate` requests the replaced version still answers after the candidate's deploy, and after a rollback's. */
	previousAnswers: number
	rollbackPreviousAnswers: number
	/** The candidate's version fails to boot before any record: its `migrate` answers 500. */
	bootFails: boolean
	outcome: ProviderDeployOutcome
	rollbackOutcome: ProviderDeployOutcome
	settlement: 'succeeded' | 'failed' | 'running'
	/** Where in the object's requests each deploy happened, the run it deployed, and whether it was a rollback. */
	deploys: { at: number; runId: string; migrations: readonly string[]; rollback: boolean }[]
	/** Called at each rollback deploy, before it returns. */
	onRollback: () => Promise<void>
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
			const fixture = await createPostgres('migrating_deploy')
			return { repositories: createControlRepositories(fixture.db), db: fixture.db, close: () => fixture.close() }
		},
	},
]

for (const backend of backends) {
	describe.skipIf(backend.skip)(`the migrating deploy without a read-only window (${backend.name})`, () => {
		let opened: Backend | null = null

		afterEach(async () => {
			await opened?.close()
			opened = null
		})

		async function open() {
			const b = await backend.open()
			opened = b
			await b.repositories.registry.createApp({ id: APP, repoUrl: 'github.com/acme/crm' })
			await b.repositories.registry.upsertAppEnv(providerEnvironment(APP, ENV, { domain: 'crm.example.com' }))
			const locks = new SqlDeployLocks(b.db)
			await fixtureProtect(b.repositories.registry, locks, TARGET, false)
			const fake = new FakeEnvironments()
			for (const name of [FIRST, SECOND, DROPS]) fake.checksums.set(name, sha256Hex(migrationText(name)))
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
			// Each commit is its migrations; a run pinned to a recorded commit deploys that commit's.
			const commitMigrations = new Map<string, readonly string[]>()
			const commitOf = (migrations: readonly string[]): string => {
				const sha = sha256Hex(migrations.join('\n')).slice(0, 40)
				commitMigrations.set(sha, [...migrations])
				return sha
			}
			const commits: CommitSource = {
				anonymousReadability: () => Promise.resolve('readable'),
				requestedCommit: (input) => memoryCommits().requestedCommit(input),
				open: (input) => memoryCommits(tree(commitMigrations.get(input.commitSha) ?? [])).open(input),
			}
			const state: ProviderState = {
				migrations: [FIRST],
				bookmark: true,
				failure: null,
				previousAnswers: 0,
				rollbackPreviousAnswers: 0,
				bootFails: false,
				outcome: { state: 'succeeded' },
				rollbackOutcome: { state: 'succeeded' },
				settlement: 'succeeded',
				deploys: [],
				onRollback: () => Promise.resolve(),
			}
			let candidate: string | null = null
			const provider: ControlProvider = {
				id: TEST_PROVIDER_ID,
				normalizeRegistration: (input) => input,
				source: { binding: 'connection' },
				resolveSource: (input) => Promise.resolve({ commitSha: input.expectedCommitSha ?? commitOf(state.migrations) }),
				opsChannel: () => true,
				dataOperations: () => true,
				migrationBookmark: () => state.bookmark,
				deploy: async (input) => {
					const sha = (await b.repositories.runs.getRun(input.runId))?.commit_sha ?? null
					const migrations = (sha === null ? undefined : commitMigrations.get(sha)) ?? []
					const rollback = candidate !== null && input.runId !== candidate
					state.deploys.push({ at: fake.requests().length, runId: input.runId, migrations, rollback })
					await input.events.externalId(`${input.runId}-external`)
					if (rollback) {
						fake.deployVersion(migrations, null, state.rollbackPreviousAnswers)
						fake.bootFails = false
						await state.onRollback()
						return state.rollbackOutcome
					}
					fake.deployVersion(migrations, state.failure, state.previousAnswers)
					fake.bootFails = state.bootFails
					return state.outcome
				},
				reconcile: () => Promise.resolve({ state: state.settlement }),
			}
			// The deadline's clock: each wait between two `migrate` requests moves it, and nothing else does.
			let clock = 1_800_000_000_000
			const opsClock: LeaseClock = {
				now: () => clock,
				wait: (ms) => {
					clock += ms
					return Promise.resolve()
				},
			}
			// A run its provider leaves running is settled every 15 s; those waits pass at once, the lease's stay real.
			const settleClock: LeaseClock = { now: () => Date.now(), wait: (ms, signal) => ms === 15_000 ? Promise.resolve() : abortableWait(ms, signal) }
			const deps = (): RunDeps => ({
				repositories: b.repositories,
				lock: locks,
				secrets: new VaultSecretResolver({}),
				provider,
				logs: store,
				runLogs: store,
				commits,
				opsKeys: new VaultOpsKeys(b.repositories.opsKeys, () => Promise.resolve(vault)),
				ops: fake,
				opsClock,
				leaseClock: settleClock,
			})
			const run = async (): Promise<string> => {
				const id = uuidv7()
				await b.repositories.runs.createRun({ id, appId: APP, env: ENV, ref: 'main', trigger: 'manual', actor: 'user:test' })
				return id
			}
			const log = (runId: string): string => logs.get(`runs/${runId}/logs.ndjson`) ?? ''
			/** The first deploy publishes `FIRST`, and the object, open, applies it on its cold start. Returns its run. */
			const deployFirst = async (): Promise<string> => {
				const first = await run()
				expect(await executeDeploy(deps(), { runId: first })).toEqual({ runId: first, status: 'succeeded' })
				fake.ledger = [{ bundle: 'app', name: FIRST, checksum: sha256Hex(migrationText(FIRST)), appliedAt: '2027-01-14T08:00:00.000Z' }]
				fake.bundled = [FIRST]
				fake.previous = null
				fake.sent.length = 0
				state.deploys.length = 0
				return first
			}
			/** A run of the candidate `migrations`, which the provider double deploys as the candidate. */
			const candidateRun = async (migrations: readonly string[]): Promise<string> => {
				state.migrations = [...migrations]
				candidate = await run()
				return candidate
			}
			/** The object's requests with each deploy in its place. */
			const timeline = (): string[] => {
				const requests = fake.requests()
				for (const deploy of [...state.deploys].reverse()) requests.splice(deploy.at, 0, deploy.rollback ? 'rollback deploy' : 'deploy')
				return requests
			}
			const operations = async () => [...(await b.repositories.dataOperations.listForEnvironment(APP, ENV, { limit: 10 }))]
			const backups = async () => [...(await b.repositories.backups.listForEnvironment(APP, ENV, { limit: 10 }))]
			const migrates = (): number => fake.requests().filter((request) => request.startsWith('migrate')).length
			/** Takes the environment's lease from whoever holds it, as a Control instance that outlived its holder would. */
			const steal = async (): Promise<void> => {
				await b.db.prepare('UPDATE deploy_locks SET holder = ? WHERE lock_key = ?').bind('thief', KEY).run()
			}
			const pass = () =>
				runBackupSchedule({
					repositories: b.repositories,
					lock: locks,
					ops: fake,
					provider,
					deploys: operationDeploys(deps()),
					clock: () => clock,
					wait: opsClock.wait,
				})
			return { b, fake, state, deps, log, locks, deployFirst, candidateRun, timeline, operations, backups, migrates, steal, pass, clock: () => clock }
		}

		test('the old version answers until the new one migrated: nothing is restricted and no backup is taken', async () => {
			const { b, fake, state, deps, log, deployFirst, candidateRun, timeline, operations, backups } = await open()
			await deployFirst()
			state.previousAnswers = 2
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(timeline()).toEqual(['inspect', 'deploy', 'state application open @1', 'migrate @1', 'migrate @1', 'migrate @1'])
			expect(fake.ledger.map((row) => row.name)).toEqual([FIRST, SECOND])
			const [operation] = await operations()
			expect(operation).toMatchObject({
				kind: 'migrate',
				state: 'succeeded',
				step: 'migrate',
				target_mode: 'open',
				generation: 1,
				records_bookmark: 1,
				data_loss: 0,
				run_id: second,
				revert_run_id: null,
				migration_failure: null,
			})
			expect(await backups()).toEqual([])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
			expect(log(second)).toContain('the deploy runs as a migrate data operation (deploy, migrate; on a failure, a rollback deploy)')
			expect(log(second)).toContain(`data operation ${operation?.id} succeeded`)
			expect(await b.db.prepare('SELECT holder FROM deploy_locks WHERE lock_key = ?').bind(KEY).first()).toBeNull()
		})

		test('a migration that deletes data gets no backup and no read-only window either', async () => {
			const { state, deps, deployFirst, candidateRun, timeline, operations, backups } = await open()
			await deployFirst()
			const drops = await candidateRun([FIRST, DROPS])
			expect(await executeDeploy(deps(), { runId: drops })).toEqual({ runId: drops, status: 'succeeded' })
			expect(timeline()).toEqual(['inspect', 'deploy', 'state application open @1', 'migrate @1'])
			expect(await operations()).toMatchObject([{ state: 'succeeded', records_bookmark: 1, data_loss: 1 }])
			expect(await backups()).toEqual([])
			expect(state.deploys.map((deploy) => deploy.migrations)).toEqual([[FIRST, DROPS]])
		})

		test('a ledger with every file but another checksum is the old version: only the exact checksums are the new one', async () => {
			const { fake, deps, deployFirst, candidateRun, operations, migrates } = await open()
			await deployFirst()
			fake.checksums.set(SECOND, sha256Hex('another text'))
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(migrates()).toBe(ASKS_TO_DEADLINE)
			expect(await operations()).toMatchObject([{ state: 'failed', error_code: MIGRATION_UNCONFIRMED_CODE }])
		})

		test('no answer from the new version by the deadline fails the operation as unconfirmed, with nothing restricted', async () => {
			const { b, fake, state, deps, log, deployFirst, candidateRun, operations, migrates } = await open()
			await deployFirst()
			state.previousAnswers = 1_000
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(migrates()).toBe(ASKS_TO_DEADLINE)
			expect(fake.requests().filter((request) => request.startsWith('state'))).toEqual(['state application open @1'])
			const [operation] = await operations()
			expect(operation).toMatchObject({ state: 'failed', error_code: MIGRATION_UNCONFIRMED_CODE, step: 'migrate', target_mode: 'open' })
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
			expect(state.deploys.filter((deploy) => deploy.rollback)).toEqual([])
			expect(log(second)).toContain(`data operation ${operation?.id} failed at migrate (${MIGRATION_UNCONFIRMED_CODE}); the environment is open`)
		})

		test('a 500 of a boot that failed before any record is no answer: asked again until the deadline, then unconfirmed', async () => {
			const { b, state, deps, deployFirst, candidateRun, operations, migrates } = await open()
			await deployFirst()
			state.bootFails = true
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(migrates()).toBe(ASKS_TO_DEADLINE)
			expect(await operations()).toMatchObject([{ state: 'failed', error_code: MIGRATION_UNCONFIRMED_CODE, target_mode: 'open' }])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		for (const reason of ['rolled_back', 'record_unwritable'] as const) {
			test(`${reason}: the rollback deploy redeploys the last succeeded commit and waits for its ok`, async () => {
				const { b, fake, state, deps, log, deployFirst, candidateRun, timeline, operations } = await open()
				const first = await deployFirst()
				state.failure = reason
				// The failing version still answers twice after the rollback's deploy, as an active object's code updates deferred.
				state.rollbackPreviousAnswers = 2
				const second = await candidateRun([FIRST, SECOND])
				expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
				expect(timeline()).toEqual([
					'inspect',
					'deploy',
					'state application open @1',
					'migrate @1',
					'rollback deploy',
					'migrate @1',
					'migrate @1',
					'migrate @1',
				])
				expect(fake.ledger.map((row) => row.name)).toEqual([FIRST])
				const [operation] = await operations()
				expect(operation).toMatchObject({
					state: 'failed',
					error_code: MIGRATION_REVERTED_CODE,
					step: 'check',
					target_mode: 'open',
					migration_failure: reason,
				})
				const rollback = await b.repositories.runs.getRun(operation?.revert_run_id ?? '')
				expect(rollback).toMatchObject({ status: 'succeeded', commit_sha: (await b.repositories.runs.getRun(first))?.commit_sha })
				expect(state.deploys.map((deploy) => deploy.migrations)).toEqual([[FIRST, SECOND], [FIRST]])
				// The rollback is what the environment runs now, and the record leaves it open.
				expect((await b.repositories.runs.getLatestSucceededRun(TARGET))?.id).toBe(rollback?.id)
				expect(await recordedMaintenance(b, TARGET)).toBe('open')
				expect(log(second)).toContain(
					`failed at check (${MIGRATION_REVERTED_CODE}, the new version's migration ${reason}, rollback deploy ${rollback?.id}); the environment is open`,
				)
			})
		}

		test('a committed migration without a dataLoss line gets the rollback deploy alone: the ledger stays ahead of the code', async () => {
			const { fake, state, deps, deployFirst, candidateRun, timeline, operations } = await open()
			await deployFirst()
			state.failure = 'committed'
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(timeline()).toEqual(['inspect', 'deploy', 'state application open @1', 'migrate @1', 'rollback deploy', 'migrate @1'])
			expect(fake.ledger.map((row) => row.name)).toEqual([FIRST, SECOND])
			expect(await operations()).toMatchObject([{ state: 'failed', error_code: MIGRATION_REVERTED_CODE, migration_failure: 'committed' }])
		})

		test('a committed dataLoss migration is never rolled back: the object is closed for an operator', async () => {
			const { b, fake, state, deps, log, deployFirst, candidateRun, timeline, operations } = await open()
			await deployFirst()
			state.failure = 'committed'
			const drops = await candidateRun([FIRST, DROPS])
			expect(await executeDeploy(deps(), { runId: drops })).toEqual({ runId: drops, status: 'succeeded' })
			expect(timeline()).toEqual(['inspect', 'deploy', 'state application open @1', 'migrate @1', 'state application closed @2'])
			const [operation] = await operations()
			expect(operation).toMatchObject({
				state: 'failed',
				error_code: MIGRATION_FAILED_CODE,
				step: 'restrict',
				target_mode: 'closed',
				generation: 2,
				data_loss: 1,
				migration_failure: 'committed',
				revert_run_id: null,
			})
			expect(fake.published.get(`${APP}/${ENV}/application`)).toEqual({ generation: 2, mode: 'closed' })
			expect(await recordedMaintenance(b, TARGET)).toBe('unsettled')
			expect(log(drops)).toContain('the environment stays restricted until an operator recovers it')
		})

		test('a rollback that never answers ok by the deadline closes the object and fails the migration', async () => {
			const { b, state, deps, deployFirst, candidateRun, timeline, operations } = await open()
			await deployFirst()
			state.failure = 'rolled_back'
			state.rollbackPreviousAnswers = 1_000
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(timeline().slice(-2)).toEqual(['migrate @1', 'state application closed @2'])
			expect(timeline().filter((request) => request === 'migrate @1')).toHaveLength(1 + ASKS_TO_DEADLINE)
			expect(await operations()).toMatchObject([{ state: 'failed', error_code: MIGRATION_FAILED_CODE, step: 'restrict', target_mode: 'closed' }])
			expect(await recordedMaintenance(b, TARGET)).toBe('unsettled')
		})

		test('a rollback deploy that fails closes the object at once', async () => {
			const { b, state, deps, deployFirst, candidateRun, timeline, operations } = await open()
			await deployFirst()
			state.failure = 'rolled_back'
			state.rollbackOutcome = { state: 'failed' }
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(timeline().slice(-3)).toEqual(['migrate @1', 'rollback deploy', 'state application closed @2'])
			const [operation] = await operations()
			expect(operation).toMatchObject({ state: 'failed', error_code: MIGRATION_FAILED_CODE, step: 'restrict' })
			expect((await b.repositories.runs.getRun(operation?.revert_run_id ?? ''))?.status).toBe('failed')
		})

		test('a deploy that failed before it uploaded anything leaves the environment open and asks nothing', async () => {
			const { b, fake, state, deps, deployFirst, candidateRun, operations } = await open()
			await deployFirst()
			state.outcome = { state: 'failed', untouched: true }
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'failed' })
			expect(fake.requests()).toEqual(['inspect'])
			expect(await operations()).toMatchObject([{ state: 'failed', error_code: DEPLOY_NOT_STARTED_CODE, step: 'deploy', target_mode: 'open' }])
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('a lost lease stops the operation before the rollback deploy, and a successor carries on from the migrate step', async () => {
			const { b, fake, state, deps, locks, deployFirst, candidateRun, timeline, operations, steal, pass } = await open()
			await deployFirst()
			state.failure = 'rolled_back'
			fake.fault = async (sent) => {
				if (sent.op === 'migrate') await steal()
				return undefined
			}
			const second = await candidateRun([FIRST, SECOND])
			await executeDeploy(deps(), { runId: second })
			const [stuck] = await operations()
			expect(stuck).toMatchObject({ state: 'running', step: 'migrate', migration_failure: null, revert_run_id: null })
			expect(state.deploys.filter((deploy) => deploy.rollback)).toEqual([])
			// The holder that took the lease died: the maintenance pass fences above every generation and asks again.
			fake.fault = () => undefined
			fake.sent.length = 0
			state.deploys.length = 0
			await locks.release(KEY, 'thief')
			expect(await pass()).toMatchObject({ resumed: 1, failed: 1 })
			expect(timeline().slice(0, 4)).toEqual(['state application open @2', 'migrate @2', 'rollback deploy', 'migrate @2'])
			expect(await b.repositories.dataOperations.get(stuck?.id ?? '')).toMatchObject({
				state: 'failed',
				error_code: MIGRATION_REVERTED_CODE,
				migration_failure: 'rolled_back',
			})
			expect(await recordedMaintenance(b, TARGET)).toBe('open')
		})

		test('a rollback deploy its provider leaves running stays at revert; the next pass settles it, then waits for the ok', async () => {
			const { b, fake, state, deps, deployFirst, candidateRun, operations, pass } = await open()
			await deployFirst()
			state.failure = 'rolled_back'
			state.rollbackOutcome = { state: 'running' }
			state.settlement = 'running'
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			const [stuck] = await operations()
			expect(stuck).toMatchObject({ state: 'running', step: 'revert', migration_failure: 'rolled_back' })
			const rollback = stuck?.revert_run_id ?? ''
			expect((await b.repositories.runs.getRun(rollback))?.status).toBe('running')
			expect(await recordedMaintenance(b, TARGET)).toBe('unsettled')
			fake.sent.length = 0
			state.settlement = 'succeeded'
			expect(await pass()).toMatchObject({ resumed: 1, failed: 1 })
			// No second rollback run: the successor settled the one the record names.
			expect(state.deploys.filter((deploy) => deploy.rollback)).toHaveLength(1)
			expect((await b.repositories.runs.getRun(rollback))?.status).toBe('succeeded')
			expect(fake.requests().slice(0, 2)).toEqual(['state application open @2', 'migrate @2'])
			expect(await b.repositories.dataOperations.get(stuck?.id ?? '')).toMatchObject({ state: 'failed', error_code: MIGRATION_REVERTED_CODE })
		})

		test('a candidate before the gate keeps the read-only phase and its backup', async () => {
			const { state, deps, deployFirst, candidateRun, timeline, operations, backups } = await open()
			await deployFirst()
			state.bookmark = false
			const second = await candidateRun([FIRST, SECOND])
			expect(await executeDeploy(deps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(timeline().slice(0, 3)).toEqual(['inspect', 'state application read-only @1', 'export begin @1'])
			expect(timeline().slice(-3)).toEqual(['deploy', 'migrate @1', 'state application open @2'])
			expect(await operations()).toMatchObject([{ state: 'succeeded', records_bookmark: 0, step: 'open' }])
			expect(await backups()).toMatchObject([{ pre_migration: 1, state: 'succeeded' }])
		})
	})
}
