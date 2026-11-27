// Every terminal state of a failed bookmark migration has a way back to `open` (ADR-0069 §3, ADR-0070 §9). The matrix is
// generated from the definitions of the states: the migration's steps with the modes each one holds, its failure
// reasons, the rewind's outcomes with the states of its `arm`s, the `dataLoss` line, and whether the failed version
// answered `ok` after all. A second part puts a roll back and open recovery over it, failed or interrupted at each of
// its steps. For each cell, each recovery action (every resolution, and an ordinary deploy) runs against a fresh
// environment, and at least one must leave the environment open. Against the fake ops environment and a provider double, on SQLite always and on Postgres when
// FABRIKA_TEST_POSTGRES_URL is set.

import { OPS_MIGRATION_FAILURES, type OpsMigrationFailureReason, sha256Hex } from '@fabrika/auth-core'
import { DATA_OPERATION_RESOLUTIONS, type DataOperationResolution } from '@fabrika/control-contract'
import { type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
	BOOKMARK_MIGRATION_STEPS,
	type BookmarkMigrationStep,
	DEPLOY_NOT_STARTED_CODE,
	MIGRATION_FAILED_CODE,
	MIGRATION_REVERTED_CODE,
	NEW_VERSION_DEADLINE_S,
	NOT_REWOUND_CODE,
	type OpsTarget,
	recordedMaintenance,
	REWIND_FAILED_CODE,
	ROLLBACK_FAILED_CODE,
	ROLLBACK_RECOVERY_STEPS,
	type RollbackRecoveryStep,
	startRecovery,
} from '../data-operations'
import {
	type ControlRepositories,
	createControlRepositories,
	DATA_OPERATION_STATES,
	type DataOperationState,
	type MaintenanceMode,
	REWIND_OUTCOMES,
	type RewindOutcome,
} from '../db'
import type { CommitSource } from '../github/source/commit-files'
import type { LeaseClock } from '../lease'
import { VaultOpsKeys } from '../ops-key'
import { executeDeploy, operationDeploys, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { memoryCommits } from './helpers/commits'
import { healthOnly } from './helpers/contracts'
import { createHarness } from './helpers/harness'
import { fixtureProtect } from './helpers/lock'
import { FakeEnvironments, key } from './helpers/ops-environments'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'
import { createTestVault } from './helpers/vault'

if (!hasPostgres) console.warn(`migration-recovery-exits.test.ts Postgres half ${skipReason}`)

const ENV = 'prod'
const FIRST = '20261025000000_notes.sql'
const FIRST_TEXT = 'CREATE TABLE t_notes (id TEXT PRIMARY KEY);'
const RECORD_ID = '0192c4a0-0000-7000-8000-00000000f00d'
const RECORD_BOOKMARK = 'bookmark-0001'
const START_MS = 1_800_000_000_000

const vault = await createTestVault()

/** The states of a rewind: none asked for, each recorded outcome, and the states of its `arm`s while it has none. */
const ARM_STATES = ['unarmed', 'armed_restored', 'armed_kept', 'spent'] as const
type RewindState = 'none' | RewindOutcome | (typeof ARM_STATES)[number]
const REWIND_STATES: readonly RewindState[] = ['none', ...REWIND_OUTCOMES, ...ARM_STATES]

/** Every action that may take an environment out of a failed migration: each recovery resolution, and an ordinary deploy. */
type Action = DataOperationResolution | 'deploy'
const ACTIONS: readonly Action[] = [...DATA_OPERATION_RESOLUTIONS, 'deploy']

/** The modes a bookmark migration holds at `step`, as the machine publishes them. */
function modesAt(step: BookmarkMigrationStep): readonly MaintenanceMode[] {
	switch (step) {
		case 'deploy':
		case 'migrate':
			return ['open']
		case 'rewind':
			return ['inspect']
		case 'revert':
		case 'check':
			// `inspect` after an in-place rewind, `open` otherwise; `check` opens once the rewound object's wait passed.
			return ['inspect', 'open']
		case 'restrict':
			return ['closed']
	}
}

/** The code a migration fails with at `step`; a successor's refused fence (`stale_generation`) may stop it at any step. */
function failedWith(step: BookmarkMigrationStep): string {
	switch (step) {
		case 'deploy':
			return DEPLOY_NOT_STARTED_CODE
		case 'rewind':
			return REWIND_FAILED_CODE
		case 'check':
			return MIGRATION_REVERTED_CODE
		case 'restrict':
			return MIGRATION_FAILED_CODE
		case 'migrate':
		case 'revert':
			return 'stale_generation'
	}
}

/** The rewind columns of the record, and whether the object still holds the sentinel of an `arm`. */
function rewindColumns(state: RewindState): {
	readonly record: string | null
	readonly target: string | null
	readonly arms: number
	readonly verified: number
	readonly outcome: RewindOutcome | null
	readonly refusal: string | null
	readonly sentinel: boolean
} {
	const asked = { record: RECORD_ID, target: RECORD_BOOKMARK, refusal: null, sentinel: false }
	switch (state) {
		case 'none':
			return { record: null, target: null, arms: 0, verified: 0, outcome: null, refusal: null, sentinel: false }
		case 'rewound':
			return { ...asked, arms: 1, verified: 1, outcome: 'rewound' }
		case 'refused':
			return { ...asked, target: null, arms: 0, verified: 0, outcome: 'refused', refusal: 'version_changed' }
		case 'unarmed':
			return { ...asked, arms: 0, verified: 0, outcome: null }
		case 'armed_restored':
			return { ...asked, arms: 1, verified: 0, outcome: null }
		case 'armed_kept':
			return { ...asked, arms: 1, verified: 0, outcome: null, sentinel: true }
		case 'spent':
			return { ...asked, arms: 1, verified: 1, outcome: null }
	}
}

/**
 * Whether the failed version may have answered `ok` after all at `step` (`candidate_recovered`): `check` records it with
 * the step it closes to, after the rollback deploy succeeded.
 */
function recoveredAt(step: BookmarkMigrationStep): readonly boolean[] {
	switch (step) {
		case 'restrict':
			return [false, true]
		case 'deploy':
		case 'migrate':
		case 'rewind':
		case 'revert':
		case 'check':
			return [false]
	}
}

/** A roll back and open recovery over the migration, stopped at one of its steps, in a state other than succeeded. */
interface RecoveryState {
	readonly step: RollbackRecoveryStep
	readonly state: Exclude<DataOperationState, 'succeeded'>
}

const RECOVERY_STATES: readonly RecoveryState[] = ROLLBACK_RECOVERY_STEPS.flatMap((step) =>
	DATA_OPERATION_STATES.flatMap((state) => state === 'succeeded' ? [] : [{ step, state }])
)

/** The code a roll back and open fails with at `step`; a refused fence (`stale_generation`) may stop it at any step. */
function recoveryFailedWith(step: RollbackRecoveryStep): string {
	switch (step) {
		case 'restrict':
			return NOT_REWOUND_CODE
		case 'revert':
			return ROLLBACK_FAILED_CODE
		case 'reconcile':
		case 'check':
		case 'open':
			return 'stale_generation'
	}
}

/** The mode the recovery leaves the object in at `step`: `inspect` from its fence on, until its open is acknowledged. */
function recoveryModeAt(step: RollbackRecoveryStep, migrationMode: MaintenanceMode): MaintenanceMode {
	switch (step) {
		case 'reconcile':
			return migrationMode
		case 'restrict':
		case 'revert':
		case 'check':
		case 'open':
			return 'inspect'
	}
}

interface Cell {
	readonly step: BookmarkMigrationStep
	readonly mode: MaintenanceMode
	readonly failure: OpsMigrationFailureReason | null
	readonly rewind: RewindState
	readonly dataLoss: boolean
	readonly recovered: boolean
	readonly recovery: RecoveryState | null
}

const FAILURES: readonly (OpsMigrationFailureReason | null)[] = [null, ...OPS_MIGRATION_FAILURES]

const MIGRATION_CELLS: readonly Cell[] = BOOKMARK_MIGRATION_STEPS.flatMap((step) =>
	modesAt(step).flatMap((mode) =>
		FAILURES.flatMap((failure) =>
			REWIND_STATES.flatMap((rewind) =>
				[false, true].flatMap((dataLoss) => recoveredAt(step).map((recovered) => ({ step, mode, failure, rewind, dataLoss, recovered, recovery: null })))
			)
		)
	)
)

/** A roll back and open in each of its states, over a migration closed after each failure and each rewind state. */
const RECOVERY_CELLS: readonly Cell[] = RECOVERY_STATES.flatMap((recovery) =>
	FAILURES.flatMap((failure) =>
		REWIND_STATES.map((rewind) => ({
			step: 'restrict' as const,
			mode: 'closed' as const,
			failure,
			rewind,
			dataLoss: false,
			recovered: false,
			recovery,
		}))
	)
)

const CELLS: readonly Cell[] = [...MIGRATION_CELLS, ...RECOVERY_CELLS]

/** The state ADR-0069 §3 leaves closed for an operator: committed, not rewound, with a `dataLoss` line. */
const closedForOperator = (cell: Cell): boolean =>
	cell.recovery === null && cell.step === 'restrict' && cell.failure === 'committed' && cell.dataLoss && !cell.recovered
	&& (cell.rewind === 'none' || cell.rewind === 'refused')

const cellName = (cell: Cell): string =>
	`${cell.step}/${cell.mode}, ${cell.failure ?? 'no failure'}, rewind ${cell.rewind}${cell.dataLoss ? ', dataLoss' : ''}${
		cell.recovered ? ', candidate recovered' : ''
	}${cell.recovery === null ? '' : `; roll back and open ${cell.recovery.state} at ${cell.recovery.step}`}`

interface Backend {
	readonly repositories: ControlRepositories
	readonly db: SqlDatabase
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
			const fixture = await createPostgres('recovery_exits')
			return { repositories: createControlRepositories(fixture.db), db: fixture.db, close: () => fixture.close() }
		},
	},
]

for (const backend of backends) {
	describe.skipIf(backend.skip)(`every terminal state of a failed bookmark migration has an exit to open (${backend.name})`, () => {
		let opened: Backend | null = null
		let environments = 0

		beforeAll(async () => {
			opened = await backend.open()
		})

		afterAll(async () => {
			await opened?.close()
			opened = null
		})

		/** A fresh application with one succeeded deploy of `FIRST`, then the failed migration `cell` describes. */
		async function environment(cell: Cell) {
			const b = opened
			if (b === null) throw new Error('the backend is not open')
			const appId = `app${++environments}`
			const target: OpsTarget = { appId, env: ENV }
			await b.repositories.registry.createApp({ id: appId, repoUrl: `github.com/acme/${appId}` })
			await b.repositories.registry.upsertAppEnv(providerEnvironment(appId, ENV, { domain: `${appId}.example.com` }))
			const locks = new SqlDeployLocks(b.db)
			await fixtureProtect(b.repositories.registry, locks, target, false)
			const fake = new FakeEnvironments()
			fake.checksums.set(FIRST, sha256Hex(FIRST_TEXT))
			const tree = { 'fabrika.contract.ts': healthOnly(appId), [`db/migrations/${FIRST}`]: FIRST_TEXT }
			const commits: CommitSource = {
				anonymousReadability: () => Promise.resolve('readable'),
				requestedCommit: (input) => memoryCommits().requestedCommit(input),
				open: (input) => memoryCommits(tree).open(input),
			}
			const provider: ControlProvider = {
				id: TEST_PROVIDER_ID,
				normalizeRegistration: (input) => input,
				source: { binding: 'connection' },
				resolveSource: (input) => Promise.resolve({ commitSha: input.expectedCommitSha ?? sha256Hex(appId).slice(0, 40) }),
				opsChannel: () => true,
				dataOperations: () => true,
				migrationBookmark: () => true,
				deploy: async (input) => {
					await input.events.externalId(`${input.runId}-external`)
					fake.deployVersion([FIRST])
					return { state: 'succeeded' }
				},
				reconcile: () => Promise.resolve({ state: 'succeeded' }),
			}
			let clock = START_MS
			const opsClock: LeaseClock = {
				now: () => clock,
				wait: (ms) => {
					clock += ms
					return Promise.resolve()
				},
			}
			const deps = (): RunDeps => ({
				repositories: b.repositories,
				lock: locks,
				secrets: new VaultSecretResolver({}),
				provider,
				logs: { put: () => Promise.resolve() },
				commits,
				opsKeys: new VaultOpsKeys(b.repositories.opsKeys, () => Promise.resolve(vault)),
				ops: fake,
				opsClock,
			})
			const run = async (): Promise<string> => {
				const id = uuidv7()
				await b.repositories.runs.createRun({ id, appId, env: ENV, ref: 'main', trigger: 'manual', actor: 'user:test' })
				return id
			}
			const seconds = Math.floor(clock / 1000)
			/** A run that ended `status`, as a deploy of the last succeeded commit does. */
			const ended = async (status: 'succeeded' | 'failed', barrier: boolean): Promise<string> => {
				const id = await run()
				await b.db
					.prepare(`UPDATE runs SET status = ?, commit_sha = ?, migration_barrier = ?, external_run_id = ?, started_at = ?, finished_at = ?
						WHERE id = ?`)
					.bind(status, sha256Hex(appId).slice(0, 40), barrier ? 1 : null, `${id}-external`, seconds - 60, seconds - 30, id)
					.run()
				return id
			}
			// The last succeeded deploy, which a rollback redeploys.
			await ended('succeeded', true)
			fake.ledger = [{ bundle: 'app', name: FIRST, checksum: sha256Hex(FIRST_TEXT), appliedAt: '2027-01-14T08:00:00.000Z' }]
			fake.bundled = [FIRST]
			fake.previous = null

			const generation = await b.repositories.dataOperations.allocateGeneration(appId, ENV)
			const rewind = rewindColumns(cell.rewind)
			const migration = uuidv7()
			const waits = cell.step === 'migrate' || cell.step === 'check'
			// A recovered candidate answered after its rollback deploy succeeded.
			const reverted = cell.recovered ? await ended('succeeded', false) : null
			await b.db
				.prepare(`INSERT INTO app_env_data_operations
					(id, app_id, env, kind, step, target_mode, generation, state, error_code, actor, created_at, updated_at, finished_at, run_id,
						records_bookmark, data_loss, deadline_at, migration_failure, deployed, candidate_version, rewind_record, rewind_current,
						rewind_target, rewind_arms, rewind_verified, rewind_outcome, rewind_refusal, revert_run_id, candidate_recovered)
					VALUES (?, ?, ?, 'migrate', ?, ?, ?, 'failed', ?, 'user:test', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					migration,
					appId,
					ENV,
					cell.step,
					cell.mode,
					generation,
					failedWith(cell.step),
					seconds,
					seconds,
					seconds,
					uuidv7(),
					cell.dataLoss ? 1 : 0,
					waits ? seconds + NEW_VERSION_DEADLINE_S : null,
					cell.failure,
					cell.step === 'deploy' ? 0 : 1,
					cell.failure === null ? null : 'version-0002',
					rewind.record,
					rewind.record === null ? null : 'bookmark-0009',
					rewind.target,
					rewind.arms,
					rewind.verified,
					rewind.outcome,
					rewind.refusal,
					reverted,
					cell.recovered ? 1 : 0,
				)
				.run()
			fake.published.set(key(target, 'application'), { generation, mode: cell.mode })
			// The operation a person recovers: the migration, or the roll back and open over it.
			let stuck = migration
			const recovery = cell.recovery
			if (recovery !== null) {
				stuck = uuidv7()
				const recoveryGeneration = await b.repositories.dataOperations.allocateGeneration(appId, ENV)
				const failed = recovery.state === 'failed'
				// Its rollback run: none before `revert`, failed where `revert` failed, succeeded once `check` waits.
				const rollback = recovery.step === 'check' || recovery.step === 'open'
					? await ended('succeeded', false)
					: recovery.step === 'revert' && failed
					? await ended('failed', false)
					: null
				await b.db
					.prepare(`INSERT INTO app_env_data_operations
						(id, app_id, env, kind, step, target_mode, generation, state, error_code, actor, created_at, updated_at, finished_at,
							recovers_operation_id, resolution, recovery_rollback, revert_run_id, deadline_at)
						VALUES (?, ?, ?, 'recovery', ?, ?, ?, ?, ?, 'user:ops', ?, ?, ?, ?, 'open', 1, ?, ?)`)
					.bind(
						stuck,
						appId,
						ENV,
						recovery.step,
						recovery.step === 'open' ? 'open' : 'inspect',
						recoveryGeneration,
						recovery.state,
						failed ? recoveryFailedWith(recovery.step) : null,
						seconds,
						seconds,
						failed ? seconds : null,
						migration,
						rollback,
						recovery.step === 'check' ? seconds + NEW_VERSION_DEADLINE_S : null,
					)
					.run()
				fake.published.set(key(target, 'application'), { generation: recoveryGeneration, mode: recoveryModeAt(recovery.step, cell.mode) })
			}
			if (rewind.sentinel) {
				fake.rewinds.set('application', { sentinels: new Map([[migration, { current: 'bookmark-0009', target: RECORD_BOOKMARK }]]), arms: rewind.arms })
			}
			const dataDeps = () => ({
				repositories: b.repositories,
				lock: locks,
				ops: fake,
				deploys: operationDeploys(deps()),
				clock: () => clock,
				wait: opsClock.wait,
			})

			/** Runs `action`, then whether the environment is open: Control's record says so and the object holds it. */
			const exits = async (action: Action): Promise<boolean> => {
				if (action === 'deploy') {
					await executeDeploy(deps(), { runId: await run() })
				} else {
					await startRecovery(dataDeps(), { ...target, operationId: stuck, resolution: action, actor: 'user:ops' })
				}
				const published = fake.published.get(key(target, 'application'))
				return (await recordedMaintenance(b, target)) === 'open' && published?.mode === 'open'
			}
			return { target, migration, exits, run, deps, dataDeps }
		}

		for (const cell of CELLS) {
			test(cellName(cell), async () => {
				const opens: Action[] = []
				for (const action of ACTIONS) {
					const { exits } = await environment(cell)
					if (await exits(action)) opens.push(action)
				}
				expect(opens.length).toBeGreaterThan(0)
			})
		}

		test('the state closed for an operator: roll back and open is refused, an open recovery opens, and a deploy fixes forward', async () => {
			const closed = CELLS.filter(closedForOperator)
			expect(closed.length).toBeGreaterThan(0)
			for (const cell of closed) {
				const refused = await environment(cell)
				expect(await startRecovery(refused.dataDeps(), { ...refused.target, operationId: refused.migration, resolution: 'rollback', actor: 'user:ops' }))
					.toEqual({ kind: 'refused', reason: 'not_recoverable' })
				const { exits, run, deps } = await environment(cell)
				expect(await exits('open')).toBe(true)
				const fix = await run()
				expect(await executeDeploy(deps(), { runId: fix })).toEqual({ runId: fix, status: 'succeeded' })
			}
		})
	})
}
