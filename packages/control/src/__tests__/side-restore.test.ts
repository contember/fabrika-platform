// A side restore (ADR-0070 §9) recovers an environment's data as of a past time: a clone is listed by a deploy, the
// original is frozen, backed up and rehearsed, the backup is imported into the clone, the pointer deploy moves ordinary
// traffic to it, and the original is rewound for an operator to read. Against the fake ops environment and a provider
// double, with the real deploy path, SQL lease and records on SQLite always and on Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import { type ApplicationObjects, MAX_APPLICATION_OBJECTS } from '@fabrika/auth-core'
import { type BlobStore, type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	advanceDataOperation,
	BACKUP_FAILED_CODE,
	BOOKMARK_UNAVAILABLE_CODE,
	CLONE_NOT_SERVING_CODE,
	type DataOperationDeps,
	IMPORT_FAILED_CODE,
	LIST_FAILED_CODE,
	type OpsTarget,
	POINT_FAILED_CODE,
	recordedMaintenance,
	recordedObjects,
	REHEARSAL_FAILED_CODE,
	restoreClone,
	REWIND_FAILED_CODE,
	startRestore,
	UNEXPECTED_SCHEMA_CODE,
} from '../data-operations'
import { type ControlRepositories, createControlRepositories, type DataOperationStep, type RestoreDeploy } from '../db'
import { type LeaseFence, runLeaseKey } from '../lease'
import { VaultOpsKeys } from '../ops-key'
import { executeDeploy, operationDeploys, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import type { ControlRpcDeps } from '../services'
import { memoryCommits } from './helpers/commits'
import { healthOnly } from './helpers/contracts'
import { createHarness } from './helpers/harness'
import { authWithPermissions } from './helpers/iam'
import { fixtureProtect } from './helpers/lock'
import { FakeEnvironments, type Sent } from './helpers/ops-environments'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'
import { rpcRequest, rpcResult } from './helpers/rpc'
import { createTestVault } from './helpers/vault'

if (!hasPostgres) console.warn(`side-restore.test.ts Postgres half ${skipReason}`)

const APP = 'crm'
const ENV = 'prod'
const TARGET: OpsTarget = { appId: APP, env: ENV }
const MIGRATION = '20261025000000_notes.sql'
const APPLIED = { bundle: 'app', name: MIGRATION, checksum: 'a'.repeat(64), appliedAt: '2027-01-14T08:00:00.000Z' }
const AT = '2027-01-15T07:00:00.000Z'
const NOW = Date.parse('2027-01-15T09:00:00.000Z')
const DEFAULTS: ApplicationObjects = { object: 'application', objects: ['application', 'rehearsal'] }

const vault = await createTestVault()

/** Thrown from a request or a deploy to stand for Control dying there: nothing after it runs, the lease is released. */
class Crash extends Error {}

/** Every request the backup and its rehearsal send at generation `g`, the original frozen `read-only`. */
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

/** Every request the import into `clone` sends at generation `g`. */
function importInto(clone: string, g: number): string[] {
	return [
		`state ${clone} inspect @${g}`,
		`import ${clone} begin @${g}`,
		`import ${clone} part 1 @${g}`,
		`import ${clone} part 2 @${g}`,
		`import ${clone} part 3 @${g}`,
		`import ${clone} link 2 @${g}`,
		`import ${clone} verify @${g}`,
		`import ${clone} verify @${g}`,
		`import ${clone} complete @${g}`,
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
			const fixture = await createPostgres('side_restore')
			return { repositories: createControlRepositories(fixture.db), db: fixture.db, close: () => fixture.close() }
		},
	},
]

/** What the provider double does with one deploy: succeed, fail after accepting it, or refuse it before accepting it. */
type Verdict = 'succeeded' | 'failed' | 'not_accepted'

for (const backend of backends) {
	describe.skipIf(backend.skip)(`a side restore (${backend.name})`, () => {
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
			fake.bundled = [MIGRATION]
			fake.ledger = [APPLIED]
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
			const state = {
				serves: true,
				/** Where in the object's requests each deploy happened, and the pointer it was handed. */
				deploys: [] as { at: number; objects: ApplicationObjects | undefined }[],
				verdict: (_objects: ApplicationObjects | undefined): Verdict => 'succeeded',
				/** Whether the clone boots once traffic reaches it. */
				cloneBoots: true,
			}
			const provider: ControlProvider = {
				id: TEST_PROVIDER_ID,
				normalizeRegistration: (input) => input,
				source: { binding: 'connection' },
				resolveSource: () => Promise.resolve({ commitSha: 'a'.repeat(40) }),
				opsChannel: () => state.serves,
				deploy: async (input) => {
					state.deploys.push({ at: fake.requests().length, objects: input.applicationObjects })
					const verdict = state.verdict(input.applicationObjects)
					if (verdict === 'not_accepted') throw new Error('the provider refused the deploy')
					await input.events.externalId(`${input.runId}-external`)
					if (verdict === 'failed') return { state: 'failed' }
					// The version now running sends ordinary traffic to the pointer's serving object.
					fake.serving = input.applicationObjects?.object ?? 'application'
					if (!state.cloneBoots && fake.serving !== 'application') fake.bootFailures.add(fake.serving)
					return { state: 'succeeded' }
				},
			}
			const runDeps = (): RunDeps => ({
				repositories: b.repositories,
				lock: locks,
				secrets: new VaultSecretResolver({}),
				provider,
				logs: store,
				runLogs: store,
				commits: memoryCommits({ 'fabrika.contract.ts': healthOnly(APP), [`db/migrations/${MIGRATION}`]: 'CREATE TABLE notes (id TEXT PRIMARY KEY);' }),
				opsKeys: new VaultOpsKeys(b.repositories.opsKeys, () => Promise.resolve(vault)),
				ops: fake,
			})
			/** Control dying right after one of the restore's deploys ran, before it recorded anything about it. */
			let crashAfter: RestoreDeploy | null = null
			const deps = (): DataOperationDeps => {
				const real = operationDeploys(runDeps())
				return {
					repositories: b.repositories,
					lock: locks,
					ops: fake,
					wait: () => Promise.resolve(),
					deploys: {
						servesOps: (target) => real.servesOps(target),
						run: async (lease, runId, objects) => {
							await real.run(lease, runId, objects)
							const [operation] = await operations()
							const restore = operation === undefined ? null : await b.repositories.restores.get(operation.id)
							const deploy = restore === null ? null : restore.list_run_id === runId ? 'list' : restore.point_run_id === runId ? 'point' : 'revert'
							if (deploy !== null && deploy === crashAfter) {
								crashAfter = null
								throw new Crash()
							}
						},
					},
				}
			}
			const run = async (): Promise<string> => {
				const id = uuidv7()
				await b.repositories.runs.createRun({ id, appId: APP, env: ENV, ref: 'main', trigger: 'manual', actor: 'user:test' })
				return id
			}
			const operations = async () => [...(await b.repositories.dataOperations.listForEnvironment(APP, ENV, { limit: 10 }))]
			const backups = async () => [...(await b.repositories.backups.listForEnvironment(APP, ENV, { limit: 10 }))]
			/** The first deploy, which the restore's deploys redeploy. */
			const deployFirst = async (): Promise<void> => {
				const first = await run()
				expect(await executeDeploy(runDeps(), { runId: first })).toEqual({ runId: first, status: 'succeeded' })
				fake.sent.length = 0
				state.deploys.length = 0
			}
			const restore = () => startRestore(deps(), { ...TARGET, at: AT, actor: 'user:test', now: NOW })
			/** The object's requests with each deploy in its place, named by the object its pointer serves. */
			const timeline = (): string[] => {
				const requests = fake.requests()
				for (const deploy of [...state.deploys].reverse()) requests.splice(deploy.at, 0, `deploy ${deploy.objects?.object ?? 'none'}`)
				return requests
			}
			const restoreRow = async () => {
				const [operation] = await operations()
				return operation === undefined ? null : await b.repositories.restores.get(operation.id)
			}
			const setCrash = (deploy: RestoreDeploy | null): void => {
				crashAfter = deploy
			}
			return { b, fake, state, deps, runDeps, run, operations, backups, deployFirst, restore, timeline, restoreRow, setCrash, locks }
		}

		/** Writes under the environment's lease, as a holder Control's records accept. */
		async function asHolder<T>(b: Backend, write: (fence: LeaseFence) => Promise<T>): Promise<T> {
			const locks = new SqlDeployLocks(b.db)
			expect(await locks.acquire(runLeaseKey(APP, ENV), 'operator', 60_000)).toBe(true)
			try {
				return await write({ holder: 'operator', nowMs: Date.now() })
			} finally {
				await locks.release(runLeaseKey(APP, ENV), 'operator')
			}
		}

		test('the happy path lists the clone, freezes, backs up, imports, promotes, points, rewinds and checks, in order', async () => {
			const f = await open()
			await f.deployFirst()
			const outcome = await f.restore()
			expect(outcome).toMatchObject({ kind: 'driven', result: 'succeeded' })
			const [operation] = await f.operations()
			if (operation === undefined) throw new Error('no operation')
			const clone = restoreClone(operation.id)
			expect(f.timeline()).toEqual([
				'inspect',
				`deploy application`,
				...backupAndRehearsal(2),
				...importInto(clone, 2),
				`state ${clone} open @3`,
				'state application inspect @3',
				`deploy ${clone}`,
				`inspect ${clone}`,
				'state application inspect @4',
				'restore application prepare @4',
				'restore application arm @4',
				'restore application verify',
				'inspect',
				`inspect ${clone}`,
			])
			// The listing deploy carries the clone in the list; the pointer deploy makes it the serving object.
			expect(f.state.deploys.map((deploy) => deploy.objects)).toEqual([
				{ object: 'application', objects: ['application', 'rehearsal', clone] },
				{ object: clone, objects: ['application', 'rehearsal', clone] },
			])
			expect(operation).toMatchObject({ kind: 'restore', state: 'succeeded', step: 'check', target_mode: 'open', generation: 4, error_code: null })
			expect(await f.restoreRow()).toMatchObject({
				at: AT,
				original: 'application',
				clone,
				current_bookmark: 'bookmark-0009',
				target_bookmark: 'bookmark-0005',
				undo_bookmark: 'bookmark-undo',
				arms: 1,
				failure: null,
			})
			expect(await f.backups()).toMatchObject([{ operation_id: operation.id, object: 'application', state: 'succeeded', rehearsal: 'passed' }])
			expect(await recordedObjects(f.b, TARGET)).toEqual({ object: clone, objects: ['application', 'rehearsal', clone] })
			expect(await recordedMaintenance(f.b, TARGET)).toBe('open')

			// A later ordinary deploy still writes the moved pointer.
			f.state.deploys.length = 0
			const later = await f.run()
			expect(await executeDeploy(f.runDeps(), { runId: later })).toEqual({ runId: later, status: 'succeeded' })
			expect(f.state.deploys.map((deploy) => deploy.objects)).toEqual([{ object: clone, objects: ['application', 'rehearsal', clone] }])
		})

		test('an environment without a recorded pointer deploys the defaults', async () => {
			const f = await open()
			await f.deployFirst()
			const second = await f.run()
			expect(await executeDeploy(f.runDeps(), { runId: second })).toEqual({ runId: second, status: 'succeeded' })
			expect(f.state.deploys.map((deploy) => deploy.objects)).toEqual([DEFAULTS])
			expect(await f.b.repositories.applicationObjects.get(APP, ENV)).toBeNull()
		})

		test('a failed listing deploy fails the restore before anything is frozen, and the pointer stays', async () => {
			const f = await open()
			await f.deployFirst()
			f.state.verdict = () => 'failed'
			expect(await f.restore()).toMatchObject({ result: 'failed', operation: { state: 'failed', step: 'list', error_code: LIST_FAILED_CODE } })
			expect(f.fake.requests()).toEqual(['inspect'])
			expect(await f.b.repositories.applicationObjects.get(APP, ENV)).toBeNull()
			expect(await recordedMaintenance(f.b, TARGET)).toBe('open')
		})

		test('a failed backup or rehearsal opens the original again at a new generation', async () => {
			for (
				const [fault, code] of [
					[(sent: Sent) => sent.op === 'export' && sent.part === 2 ? { refused: 'row_too_large' as const, table: 't2' } : undefined, BACKUP_FAILED_CODE],
					[
						(sent: Sent) =>
							sent.op === 'import' && sent.object === 'rehearsal' && sent.step === 'verify'
								? { refused: 'verify_mismatch' as const, table: 't1' }
								: undefined,
						REHEARSAL_FAILED_CODE,
					],
				] as const
			) {
				const f = await open()
				await f.deployFirst()
				f.fake.fault = fault
				expect(await f.restore()).toMatchObject({ result: 'failed', operation: { state: 'failed', step: 'open', generation: 3, error_code: code } })
				expect(f.fake.requests().at(-1)).toBe('state application open @3')
				expect(f.fake.requests().filter((request) => request.includes('application-'))).toEqual([])
				expect(await recordedMaintenance(f.b, TARGET)).toBe('open')
				await opened?.close()
				opened = null
			}
		})

		test('a refused import discards the clone and opens the original again; the same backup is not retried', async () => {
			const f = await open()
			await f.deployFirst()
			f.fake.fault = (sent) =>
				sent.op === 'import' && sent.object !== 'rehearsal' && sent.step === 'part' && sent.part === 2 ? { refused: 'part_mismatch' } : undefined
			expect(await f.restore()).toMatchObject({
				result: 'failed',
				operation: { state: 'failed', step: 'open', generation: 3, error_code: IMPORT_FAILED_CODE },
			})
			const clone = restoreClone((await f.operations())[0]?.id ?? '')
			expect(f.fake.requests().slice(-3)).toEqual([`import ${clone} part 2 @2`, `import ${clone} discard @2`, 'state application open @3'])
			expect(f.fake.imports.get(clone)).toMatchObject({ marker: null, tables: false })
			expect(f.state.deploys).toHaveLength(1)
			expect(await f.restoreRow()).toMatchObject({ failure: IMPORT_FAILED_CODE })
			expect(await recordedMaintenance(f.b, TARGET)).toBe('open')
		})

		test('a pointer deploy no provider accepted fences the clone back and opens the original', async () => {
			const f = await open()
			await f.deployFirst()
			f.state.verdict = (objects) => objects?.object === 'application' ? 'succeeded' : 'not_accepted'
			expect(await f.restore()).toMatchObject({
				result: 'failed',
				operation: { state: 'failed', step: 'open', generation: 4, error_code: POINT_FAILED_CODE },
			})
			const clone = restoreClone((await f.operations())[0]?.id ?? '')
			expect(f.timeline().slice(-3)).toEqual([`deploy ${clone}`, `state ${clone} inspect @4`, 'state application open @4'])
			expect(await recordedObjects(f.b, TARGET)).toEqual({ object: 'application', objects: ['application', 'rehearsal', clone] })
			expect(await recordedMaintenance(f.b, TARGET)).toBe('open')
		})

		test('a pointer deploy that failed after a provider accepted it is pointed back before the original opens', async () => {
			const f = await open()
			await f.deployFirst()
			f.state.verdict = (objects) => objects?.object === 'application' ? 'succeeded' : 'failed'
			expect(await f.restore()).toMatchObject({ result: 'failed', operation: { state: 'failed', step: 'open', error_code: POINT_FAILED_CODE } })
			const clone = restoreClone((await f.operations())[0]?.id ?? '')
			expect(f.timeline().slice(-4)).toEqual([`deploy ${clone}`, 'deploy application', `state ${clone} inspect @4`, 'state application open @4'])
			expect(f.state.deploys.at(-1)?.objects).toEqual({ object: 'application', objects: ['application', 'rehearsal', clone] })
			expect(await f.restoreRow()).toMatchObject({ failure: POINT_FAILED_CODE, target_bookmark: null, arms: 0 })
		})

		test('a clone that does not boot is pointed back, fenced, and the original opens without being rewound', async () => {
			const f = await open()
			await f.deployFirst()
			f.state.cloneBoots = false
			expect(await f.restore()).toMatchObject({ result: 'failed', operation: { state: 'failed', step: 'open', error_code: CLONE_NOT_SERVING_CODE } })
			const clone = restoreClone((await f.operations())[0]?.id ?? '')
			expect(f.timeline().slice(-5)).toEqual([
				`deploy ${clone}`,
				`inspect ${clone}`,
				'deploy application',
				`state ${clone} inspect @4`,
				'state application open @4',
			])
			expect(f.fake.requests().filter((request) => request.startsWith('restore'))).toEqual([])
			expect(await recordedObjects(f.b, TARGET)).toEqual({ object: 'application', objects: ['application', 'rehearsal', clone] })
			expect(await recordedMaintenance(f.b, TARGET)).toBe('open')
		})

		test('a target time outside the recovery window leaves the clone serving and fails with bookmark_unavailable', async () => {
			const f = await open()
			await f.deployFirst()
			f.fake.bookmarkUnavailable = true
			expect(await f.restore()).toMatchObject({
				result: 'failed',
				operation: { state: 'failed', step: 'rewind', error_code: BOOKMARK_UNAVAILABLE_CODE },
			})
			const clone = restoreClone((await f.operations())[0]?.id ?? '')
			expect(f.fake.requests().slice(-2)).toEqual(['state application inspect @4', 'restore application prepare @4'])
			expect(await recordedObjects(f.b, TARGET)).toMatchObject({ object: clone })
			expect(f.fake.serving).toBe(clone)
			expect(await recordedMaintenance(f.b, TARGET)).toBe('open')
		})

		test("prepare's bookmarks are recorded, and the arm counted, before the arm is sent", async () => {
			const f = await open()
			await f.deployFirst()
			const seen: unknown[] = []
			f.fake.fault = async (sent) => {
				if (sent.op === 'restore' && sent.step === 'arm') seen.push(await f.restoreRow())
				return undefined
			}
			expect(await f.restore()).toMatchObject({ result: 'succeeded' })
			expect(seen).toMatchObject([{ current_bookmark: 'bookmark-0009', target_bookmark: 'bookmark-0005', arms: 1, undo_bookmark: null }])
		})

		test('a lost arm answer is resolved by verify, never by a blind second arm', async () => {
			const f = await open()
			await f.deployFirst()
			f.fake.fault = (sent) => sent.op === 'restore' && sent.step === 'arm' ? 'lose' : undefined
			expect(await f.restore()).toMatchObject({ result: 'succeeded', operation: { state: 'succeeded', step: 'check' } })
			expect(f.fake.requests().filter((request) => request.startsWith('restore'))).toEqual([
				'restore application prepare @4',
				'restore application arm @4',
				'restore application verify',
			])
			expect(await f.restoreRow()).toMatchObject({ arms: 1, undo_bookmark: null })
		})

		test('an arm that never resets the original is armed again after each verify, then fails', async () => {
			const f = await open()
			await f.deployFirst()
			f.fake.resets = false
			expect(await f.restore()).toMatchObject({ result: 'failed', operation: { state: 'failed', step: 'rewind', error_code: REWIND_FAILED_CODE } })
			expect(f.fake.requests().filter((request) => request.startsWith('restore'))).toEqual([
				'restore application prepare @4',
				'restore application arm @4',
				'restore application verify',
				'restore application arm @4',
				'restore application verify',
				'restore application arm @4',
				'restore application verify',
			])
			expect(await f.restoreRow()).toMatchObject({ arms: 3 })
			expect(f.fake.serving).toBe(restoreClone((await f.operations())[0]?.id ?? ''))
		})

		test('a rewound original whose ledger the clone does not hold stays inspect and fails for an operator', async () => {
			const f = await open()
			await f.deployFirst()
			f.fake.rewoundLedger = [{ ...APPLIED, checksum: 'b'.repeat(64) }]
			expect(await f.restore()).toMatchObject({ result: 'failed', operation: { state: 'failed', step: 'check', error_code: UNEXPECTED_SCHEMA_CODE } })
			const inspected = await f.fake.inspect(TARGET, { object: 'application', content: false })
			expect(inspected).toMatchObject({ kind: 'ok', value: { view: { maintenance: { mode: 'inspect', generation: 4 } } } })
		})

		const STEPS: readonly DataOperationStep[] = ['list', 'restrict', 'backup', 'verify', 'import', 'promote', 'point', 'serve', 'rewind', 'check']
		for (const step of STEPS) {
			test(`a successor resumes a restore whose holder died at ${step}`, async () => {
				const f = await open()
				await f.deployFirst()
				if (step === 'list' || step === 'point') {
					// Dies after the deploy ran and before the holder recorded it.
					f.setCrash(step)
				} else {
					let crashed = false
					f.fake.fault = async (sent) => {
						if (crashed || sent.op === 'inspect' && (await f.operations()).length === 0) return undefined
						if ((await f.operations())[0]?.step !== step) return undefined
						crashed = true
						throw new Crash()
					}
				}
				await expect(f.restore()).rejects.toBeInstanceOf(Crash)
				const [stuck] = await f.operations()
				expect(stuck).toMatchObject({ kind: 'restore', state: 'running', step })
				f.fake.fault = () => undefined
				const resumed = await advanceDataOperation(f.deps(), stuck?.id ?? '')
				expect(resumed).toMatchObject({ kind: 'driven', result: 'succeeded', operation: { state: 'succeeded', step: 'check' } })
				const clone = restoreClone(stuck?.id ?? '')
				// Each deploy ran once, whoever ran it.
				expect(f.state.deploys.map((deploy) => deploy.objects?.object)).toEqual(['application', clone])
				expect(await recordedObjects(f.b, TARGET)).toEqual({ object: clone, objects: ['application', 'rehearsal', clone] })
				expect(await f.restoreRow()).toMatchObject({ failure: null, target_bookmark: 'bookmark-0005' })
				expect(await recordedMaintenance(f.b, TARGET)).toBe('open')
			})
		}

		test('a successor carries a failed restore back to the original after its holder died at revert or at open', async () => {
			for (const at of ['revert', 'open'] as const) {
				const f = await open()
				await f.deployFirst()
				f.state.cloneBoots = false
				if (at === 'revert') {
					f.setCrash('revert')
				} else {
					let crashed = false
					f.fake.fault = async (sent) => {
						if (crashed || sent.op !== 'state' || (await f.operations())[0]?.step !== 'open') return undefined
						crashed = true
						throw new Crash()
					}
				}
				await expect(f.restore()).rejects.toBeInstanceOf(Crash)
				const [stuck] = await f.operations()
				expect(stuck).toMatchObject({ kind: 'restore', state: 'running', step: at })
				f.fake.fault = () => undefined
				expect(await advanceDataOperation(f.deps(), stuck?.id ?? '')).toMatchObject({
					result: 'failed',
					operation: { state: 'failed', step: 'open', error_code: CLONE_NOT_SERVING_CODE },
				})
				const clone = restoreClone(stuck?.id ?? '')
				expect(f.state.deploys.map((deploy) => deploy.objects?.object)).toEqual(['application', clone, 'application'])
				expect(await recordedObjects(f.b, TARGET)).toEqual({ object: 'application', objects: ['application', 'rehearsal', clone] })
				// The clone is fenced back to `inspect` and the original opened, both at the operation's last generation.
				const [failed] = await f.operations()
				for (const [object, mode] of [[clone, 'inspect'], ['application', 'open']] as const) {
					expect(await f.fake.inspect(TARGET, { object, content: false })).toMatchObject({
						value: { view: { maintenance: { mode, generation: failed?.generation } } },
					})
				}
				expect(await recordedMaintenance(f.b, TARGET)).toBe('open')
				await opened?.close()
				opened = null
			}
		})

		test('a restore is refused while the list holds the most objects the ops channel reaches', async () => {
			const f = await open()
			await f.deployFirst()
			const listed = Array.from({ length: MAX_APPLICATION_OBJECTS }, (_, index) => (index === 0 ? 'application' : `object-${index}`))
			expect(await asHolder(f.b, (fence) => f.b.repositories.applicationObjects.set(APP, ENV, { serving: 'application', listed }, fence))).toBe(true)
			expect(await f.restore()).toEqual({ kind: 'refused', reason: 'too_many_objects' })
			expect(await f.operations()).toEqual([])
			expect(f.state.deploys).toEqual([])
		})

		test('an environment without a domain, a release without ops, nothing deployed or a future time is refused', async () => {
			const noDomain = await open({ domain: null })
			await noDomain.deployFirst()
			expect(await noDomain.restore()).toEqual({ kind: 'refused', reason: 'not_served' })
			await opened?.close()

			const noOps = await open()
			await noOps.deployFirst()
			noOps.state.serves = false
			expect(await noOps.restore()).toEqual({ kind: 'refused', reason: 'not_served' })
			noOps.state.serves = true
			expect(await startRestore(noOps.deps(), { ...TARGET, at: '2027-01-15T10:00:00.000Z', actor: 'user:test', now: NOW })).toEqual({
				kind: 'refused',
				reason: 'not_past',
			})
			expect(await noOps.operations()).toEqual([])
			expect(noOps.fake.sent).toEqual([])
			await opened?.close()

			const nothing = await open()
			expect(await nothing.restore()).toEqual({ kind: 'refused', reason: 'nothing_deployed' })
			expect(await nothing.operations()).toEqual([])
		})

		test('data.start starts a restore under data.manage, and refuses a caller without it with the same 404', async () => {
			const f = await open()
			await f.deployFirst()
			// The listing deploy stays with the provider, so the started record answers before any grace period.
			f.state.verdict = () => 'failed'
			const call = async (permissions: { action: string; scope: { type: 'app'; value: string } }[], input: unknown) => {
				const deps: ControlRpcDeps = {
					repositories: f.b.repositories,
					auth: authWithPermissions(permissions),
					queue: { send: () => Promise.resolve() },
					logs: { get: () => Promise.resolve(null) },
					provider: f.runDeps().provider,
					lock: f.locks,
					cancelRun: () => Promise.resolve(),
					opsTransport: f.fake,
					runDeps: () => Promise.resolve(f.runDeps()),
				}
				const response = await rpcResult(rpcRequest('data.start', input), deps)
				return { status: response.status, body: await response.json() }
			}
			const grant = (action: string) => ({ action, scope: { type: 'app' as const, value: APP } })
			const input = { ...TARGET, kind: 'restore', at: '2026-01-15T08:00:00+01:00' }
			expect((await call([grant('data.read')], input)).status).toBe(404)
			expect(f.fake.sent).toEqual([])
			expect((await call([grant('data.manage')], { ...input, at: '2999-01-01T00:00:00Z' })).status).toBe(400)
			const started = await call([grant('data.read'), grant('data.manage')], input)
			expect(started).toMatchObject({ status: 200, body: { kind: 'restore', state: 'failed', step: 'list', errorCode: LIST_FAILED_CODE } })
			expect(await f.restoreRow()).toMatchObject({ at: '2026-01-15T07:00:00.000Z' })
		})
	})
}

describe('migration 0023 (sqlite)', () => {
	test('rebuilding the operations table keeps every operation, backup and part, and their cascades', () => {
		const dir = join(import.meta.dir, '..', '..', 'migrations')
		const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()
		const db = new Database(':memory:')
		db.exec('PRAGMA foreign_keys = ON')
		for (const file of files.filter((name) => name < '0023')) db.exec(readFileSync(join(dir, file), 'utf8'))
		db.exec(`INSERT INTO apps (id, repo_url) VALUES ('crm', 'github.com/acme/crm')`)
		db.exec(`INSERT INTO app_envs (app_id, env, provider, provider_target_json, provider_artifact_json) VALUES ('crm', 'prod', 'test', '{}', '{}')`)
		db.exec(`INSERT INTO app_env_data_operations (id, app_id, env, kind, step, target_mode, generation, state, actor, created_at, updated_at)
			VALUES ('a', 'crm', 'prod', 'backup', 'verify', 'open', 1, 'running', 'user:test', 1, 1)`)
		db.exec(`INSERT INTO app_env_data_operations
			(id, app_id, env, kind, step, target_mode, generation, state, actor, created_at, updated_at, recovers_operation_id, resolution)
			VALUES ('b', 'crm', 'prod', 'recovery', 'reconcile', 'closed', 2, 'running', 'user:test', 1, 1, 'a', 'resume')`)
		db.exec(`INSERT INTO app_env_backups (id, app_id, env, operation_id, object, dump_id, state, created_at, rehearsal, pre_migration)
			VALUES ('k', 'crm', 'prod', 'a', 'application', 'k', 'running', 1, 'pending', 1)`)
		db.exec(`INSERT INTO app_env_backup_parts (backup_id, part, ack, linked) VALUES ('k', 1, '{}', 0)`)
		db.exec(readFileSync(join(dir, '0023_side_restore.sql'), 'utf8'))
		expect(db.query('SELECT id, recovers_operation_id FROM app_env_data_operations ORDER BY id').all()).toEqual([
			{ id: 'a', recovers_operation_id: null },
			{ id: 'b', recovers_operation_id: 'a' },
		])
		expect(db.query('SELECT id, operation_id, pre_migration FROM app_env_backups').all()).toEqual([{ id: 'k', operation_id: 'a', pre_migration: 1 }])
		expect(db.query('SELECT backup_id, part FROM app_env_backup_parts').all()).toEqual([{ backup_id: 'k', part: 1 }])
		expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
		db.exec(`INSERT INTO app_env_data_operations (id, app_id, env, kind, step, target_mode, generation, state, actor, created_at, updated_at)
			VALUES ('c', 'crm', 'prod', 'restore', 'rewind', 'open', 3, 'running', 'user:test', 1, 1)`)
		db.exec(`INSERT INTO app_env_restores (operation_id, app_id, env, at, original, clone, created_at)
			VALUES ('c', 'crm', 'prod', '2027-01-15T07:00:00.000Z', 'application', 'application-c', 1)`)
		db.exec(`DELETE FROM app_env_data_operations WHERE id = 'c'`)
		expect(db.query('SELECT operation_id FROM app_env_restores').all()).toEqual([])
		db.exec(`DELETE FROM app_env_data_operations WHERE id = 'b'`)
		db.exec(`DELETE FROM app_env_data_operations WHERE id = 'a'`)
		expect(db.query('SELECT id FROM app_env_backups').all()).toEqual([])
		expect(db.query('SELECT backup_id FROM app_env_backup_parts').all()).toEqual([])
		db.close()
	})
})
