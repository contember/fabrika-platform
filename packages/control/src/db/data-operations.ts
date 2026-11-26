import type { OpsMigrationFailureReason } from '@fabrika/auth-core'
import type { SqlDatabase } from '@fabrika/platform'
import { type LeaseFence, runLeaseKey } from '../lease'
import { type BackupCheckpoint, backupCheckpoint } from './backups'
import { firstRow } from './returning'

/** What an environment's object admits (ADR-0069 §3). */
export type MaintenanceMode = 'open' | 'read-only' | 'closed' | 'inspect'

export type DataOperationKind = 'maintenance' | 'backup' | 'migrate' | 'recovery' | 'restore'

/**
 * `restrict` and `open` publish a generation; `backup`, `verify`, `deploy` and `migrate` run between them. A recovery
 * first `reconcile`s the record with the object's published state, and `resume` hands back to the interrupted operation.
 * A restore also `list`s its clone, `import`s into it, `promote`s it, `point`s ordinary traffic at it, waits for it to
 * `serve`, `rewind`s the original and `check`s its schema; `revert` points traffic back at the original. A bookmark
 * migration `rewind`s a committed, never-booted migration in place, `revert` is its rollback deploy, `check` waits for
 * its `ok`, and `restrict` publishes `closed`.
 */
export type DataOperationStep =
	| 'reconcile'
	| 'restrict'
	| 'backup'
	| 'verify'
	| 'deploy'
	| 'migrate'
	| 'resume'
	| 'open'
	| 'list'
	| 'import'
	| 'promote'
	| 'point'
	| 'serve'
	| 'rewind'
	| 'check'
	| 'revert'

export type DataOperationState = 'running' | 'succeeded' | 'failed'

/** What a recovery does after its closed fence: resume the interrupted operation, or open the object. */
export type DataOperationResolution = 'resume' | 'open'

export interface DataOperationRow {
	id: string
	app_id: string
	env: string
	kind: DataOperationKind
	step: DataOperationStep
	/** The mode the operation requires of the object at its step. */
	target_mode: MaintenanceMode
	/** The latest generation the operation reserved; it only rises. */
	generation: number
	state: DataOperationState
	/** A code once failed; never free text. */
	error_code: string | null
	/** An opaque principal id (as `runActor`), never an email or label. */
	actor: string
	created_at: number
	updated_at: number
	finished_at: number | null
	/** A recovery's interrupted operation, of the same environment; `null` for every other kind. */
	recovers_operation_id: string | null
	/** A recovery's choice after its closed fence; `null` for every other kind. */
	resolution: DataOperationResolution | null
	/** The run a `migrate` operation deploys, of the same environment; `null` for every other kind. */
	run_id: string | null
	/** 1 for a `migrate` operation whose candidate records the migration bookmark: it restricts nothing (ADR-0069 §3). */
	records_bookmark: number
	/** 1 for a `migrate` operation whose candidate brings a migration with a `dataLoss` statement. */
	data_loss: number
	/** Unix seconds: how long a bookmark migration waits at `migrate` or `check` for an answer of the new version. */
	deadline_at: number | null
	/** The rollback deploy of a failed bookmark migration, named once before it is created. */
	revert_run_id: string | null
	/** Why the new version of a bookmark migration answered `migration_failed`, which decides its recovery. */
	migration_failure: OpsMigrationFailureReason | null
	/** 1 once the provider deployed a bookmark migration's run, which stays running until the migration ends. */
	deployed: number
	/** The Worker version that answered a bookmark migration's `migration_failed`; `null` while unknown. */
	candidate_version: string | null
	/** 1 when that version answered `ok` while the rollback deployed, so the operation closed for an operator. */
	candidate_recovered: number
	/** The migration record an in-place rewind names (ADR-0070 §9): the one the new version's `committed` 422 answered. */
	rewind_record: string | null
	/** `prepare`'s bookmarks, recorded before anything is armed. */
	rewind_current: string | null
	rewind_target: string | null
	/** Each `arm`, counted before it is sent. */
	rewind_arms: number
	/** The undo bookmark an answered `arm` returned; `null` while none answered. */
	rewind_undo: string | null
	/**
	 * How many arms a `verify` answered `present` after a transition proved their reset; an arm counted beyond it is
	 * outstanding while the outcome is unknown.
	 */
	rewind_verified: number
	/** `rewound` once `verify` found the sentinel gone; `refused` when the object refused the rewind. */
	rewind_outcome: RewindOutcome | null
	/** The object's reason for a refused rewind. */
	rewind_refusal: string | null
}

export type RewindOutcome = 'rewound' | 'refused'

export interface DataOperationFields {
	id: string
	appId: string
	env: string
	step: DataOperationStep
	targetMode: MaintenanceMode
	/** Allocated by `allocateGeneration` before the operation sends any request under it. */
	generation: number
	/** An opaque principal id (as `runActor`), never an email or label. */
	actor: string
}

export type DataOperationInput =
	& DataOperationFields
	& (
		| { kind: Exclude<DataOperationKind, 'recovery' | 'migrate' | 'restore'> }
		| { kind: 'recovery'; recovers: { operationId: string; resolution: DataOperationResolution } }
		| { kind: 'migrate'; runId: string; recordsBookmark: boolean; dataLoss: boolean }
		| { kind: 'restore'; restore: { at: string; original: string; clone: string } }
	)

export interface DataOperationAdvance {
	/** The step the caller read; another one means it lost a race and nothing changes. */
	expectedStep: DataOperationStep
	step: DataOperationStep
	targetMode?: MaintenanceMode
	/** A freshly allocated generation, above the recorded one. */
	generation?: number
	/** The environment's pointer, recorded in the same batch only once the operation moved (a restore's deploys). */
	objects?: { readonly serving: string; readonly listed: readonly string[] }
	/** Unix seconds: the wait of the step it moves to (`deadline_at`). */
	deadlineAt?: number
	/** The reason the new version's `migration_failed` named, recorded once with the step it decides. */
	migrationFailure?: OpsMigrationFailureReason
	/** The Worker version that answered it. */
	candidateVersion?: string
	/** The failed version answered `ok` while the rollback deployed. */
	candidateRecovered?: true
	/** The migration record the in-place rewind names. */
	rewindRecord?: string
	/** The rewind's outcome, with the object's reason when it refused. */
	rewind?: { readonly outcome: 'rewound' } | { readonly outcome: 'refused'; readonly refusal: string }
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/

/** The lease row an operation's writes hold, derived from the row they write. */
const operationLease = `EXISTS (SELECT 1 FROM deploy_locks
	WHERE lock_key = app_env_data_operations.app_id || ':' || app_env_data_operations.env AND holder = ? AND expires_at > ?)`

/**
 * Control's record of the data operations it drives on an environment's object (ADR-0069), and the per-environment
 * counter their generations come from. Every write that creates or advances an operation is fenced on the
 * environment's deploy lease in the same statement.
 */
export class DataOperationRepository {
	constructor(private readonly d1: SqlDatabase, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	/**
	 * Records a running operation; `null` when `fence` does not hold the environment's lease. A recovery of an operation
	 * that is not of the same environment fails on the foreign key and records nothing. A restore's record is written in
	 * the same batch, so no restore operation exists without it.
	 */
	async create(input: DataOperationInput, fence: LeaseFence): Promise<DataOperationRow | null> {
		const key = runLeaseKey(input.appId, input.env)
		const now = this.now()
		const restore = input.kind === 'restore'
			? [
				this.d1
					.prepare(`INSERT INTO app_env_restores (operation_id, app_id, env, at, original, clone, arms, created_at)
						SELECT id, app_id, env, ?, ?, ?, 0, ? FROM app_env_data_operations WHERE id = ?`)
					.bind(input.restore.at, input.restore.original, input.restore.clone, now, input.id),
			]
			: []
		// The lease row must stay locked through the write: an EXISTS alone races a takeover on Postgres.
		const results = await this.d1.batch<DataOperationRow>([
			this.d1.prepare('UPDATE deploy_locks SET holder = holder WHERE lock_key = ? AND holder = ? AND expires_at > ?').bind(
				key,
				fence.holder,
				fence.nowMs,
			),
			this.d1
				.prepare(`INSERT INTO app_env_data_operations
					(id, app_id, env, kind, step, target_mode, generation, state, error_code, actor, created_at, updated_at, finished_at,
						recovers_operation_id, resolution, run_id, records_bookmark, data_loss)
				SELECT ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?
				WHERE EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)
				RETURNING *`)
				.bind(
					input.id,
					input.appId,
					input.env,
					input.kind,
					input.step,
					input.targetMode,
					input.generation,
					input.actor,
					now,
					now,
					input.kind === 'recovery' ? input.recovers.operationId : null,
					input.kind === 'recovery' ? input.recovers.resolution : null,
					input.kind === 'migrate' ? input.runId : null,
					input.kind === 'migrate' && input.recordsBookmark ? 1 : 0,
					input.kind === 'migrate' && input.dataLoss ? 1 : 0,
					key,
					fence.holder,
					fence.nowMs,
				),
			...restore,
		])
		return results[1]?.results[0] ?? null
	}

	async get(id: string): Promise<DataOperationRow | null> {
		return await this.d1.prepare('SELECT * FROM app_env_data_operations WHERE id = ?').bind(id).first<DataOperationRow>()
	}

	/** Newest first. `id` is UUIDv7, so `before` is a sound keyset cursor, as in `RunRepository.listRuns`. */
	async listForEnvironment(appId: string, env: string, page: { before?: string; limit: number }): Promise<DataOperationRow[]> {
		const before = page.before === undefined ? '' : ' AND id < ?'
		const binds = page.before === undefined ? [appId, env, page.limit] : [appId, env, page.before, page.limit]
		const { results } = await this.d1
			.prepare(`SELECT * FROM app_env_data_operations WHERE app_id = ? AND env = ?${before} ORDER BY id DESC LIMIT ?`)
			.bind(...binds)
			.all<DataOperationRow>()
		return results
	}

	/** Every environment's running operations of `kind`, oldest first. */
	async listRunning(kind: DataOperationKind, limit: number): Promise<DataOperationRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT * FROM app_env_data_operations WHERE state = 'running' AND kind = ? ORDER BY id LIMIT ?`)
			.bind(kind, limit)
			.all<DataOperationRow>()
		return results
	}

	/**
	 * The environment's next generation, in one atomic upsert. Unfenced: a generation nobody records is a harmless gap,
	 * and no number is ever handed out twice.
	 */
	async allocateGeneration(appId: string, env: string): Promise<number> {
		const row = await firstRow<{ generation: number }>(
			this.d1
				.prepare(`INSERT INTO app_env_data_generations (app_id, env, generation) VALUES (?, ?, 1)
					ON CONFLICT (app_id, env) DO UPDATE SET generation = app_env_data_generations.generation + 1
					RETURNING generation`)
				.bind(appId, env),
		)
		return row.generation
	}

	/**
	 * Moves a running operation from `expectedStep` to the next. `false`: the lease, the step or the state was not as
	 * expected. A `checkpoint` records its backup's outcome in the same batch; each of these writes takes one.
	 */
	async advance(id: string, change: DataOperationAdvance, fence: LeaseFence, checkpoint?: BackupCheckpoint): Promise<boolean> {
		const sets = ['step = ?', 'updated_at = ?']
		const setValues: (string | number)[] = [change.step, this.now()]
		const where = ['id = ?', "state = 'running'", 'step = ?']
		const whereValues: (string | number)[] = [id, change.expectedStep]
		if (change.targetMode !== undefined) {
			sets.push('target_mode = ?')
			setValues.push(change.targetMode)
		}
		if (change.migrationFailure !== undefined) {
			sets.push('migration_failure = ?')
			setValues.push(change.migrationFailure)
		}
		if (change.deadlineAt !== undefined) {
			sets.push('deadline_at = ?')
			setValues.push(change.deadlineAt)
		}
		if (change.candidateVersion !== undefined) {
			sets.push('candidate_version = ?')
			setValues.push(change.candidateVersion)
		}
		if (change.candidateRecovered === true) sets.push('candidate_recovered = 1')
		if (change.rewindRecord !== undefined) {
			sets.push('rewind_record = ?')
			setValues.push(change.rewindRecord)
		}
		if (change.rewind !== undefined) {
			sets.push('rewind_outcome = ?')
			setValues.push(change.rewind.outcome)
			if (change.rewind.outcome === 'refused') {
				sets.push('rewind_refusal = ?')
				setValues.push(change.rewind.refusal)
			}
		}
		if (change.generation !== undefined) {
			sets.push('generation = ?')
			setValues.push(change.generation)
			where.push('generation < ?')
			whereValues.push(change.generation)
		}
		const sql = `UPDATE app_env_data_operations SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`
		if (change.objects === undefined) return await this.mutate(id, sql, [...setValues, ...whereValues], fence, checkpoint)
		if (checkpoint !== undefined) throw new Error('an advance records a backup checkpoint or the pointer, not both')
		// The pointer is written under the UPDATE's own predicate, read just before it in the batch, so it lands exactly when
		// the UPDATE matches: the lease row stays locked between them and the pointer write leaves the operation untouched.
		const matched = `${where.join(' AND ')} AND ${operationLease}`
		const matchedValues = [...whereValues, fence.holder, fence.nowMs]
		const results = await this.d1.batch<{ id: string }>([
			this.lock(id, fence),
			this.d1
				.prepare(`INSERT INTO app_env_application_objects (app_id, env, serving, listed, updated_at)
					SELECT app_id, env, ?, ?, ? FROM app_env_data_operations WHERE ${matched}
					ON CONFLICT (app_id, env) DO UPDATE SET serving = excluded.serving, listed = excluded.listed, updated_at = excluded.updated_at`)
				.bind(change.objects.serving, change.objects.listed.join(','), this.now(), ...matchedValues),
			this.d1.prepare(`UPDATE app_env_data_operations SET ${sets.join(', ')} WHERE ${matched} RETURNING id`).bind(...setValues, ...matchedValues),
		])
		return (results[2]?.results.length ?? 0) > 0
	}

	/** Names the rollback deploy of a running bookmark migration, once. `false` once named, finished, or off the lease. */
	async nameRevertRun(id: string, runId: string, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET revert_run_id = ?, updated_at = ? WHERE id = ? AND state = 'running' AND revert_run_id IS NULL`,
			[runId, this.now(), id],
			fence,
		)
	}

	/** Records the in-place rewind's `prepare` bookmarks, once, before anything is armed. */
	async rewindPrepared(id: string, bookmarks: { current: string; target: string }, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET rewind_current = ?, rewind_target = ?, updated_at = ?
				WHERE id = ? AND state = 'running' AND rewind_record IS NOT NULL AND rewind_target IS NULL`,
			[bookmarks.current, bookmarks.target, this.now(), id],
			fence,
		)
	}

	/** Counts an in-place `arm` before it is sent, so a successor never takes an unanswered one for an unsent one. */
	async rewindArming(id: string, arms: number, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET rewind_arms = ?, updated_at = ?
				WHERE id = ? AND state = 'running' AND rewind_arms = ? AND rewind_target IS NOT NULL`,
			[arms + 1, this.now(), id, arms],
			fence,
		)
	}

	/** Records the undo bookmark an answered in-place `arm` returned. */
	async rewindArmed(id: string, undo: string, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET rewind_undo = ?, updated_at = ? WHERE id = ? AND state = 'running' AND rewind_arms > 0`,
			[undo, this.now(), id],
			fence,
		)
	}

	/**
	 * A `verify` after a proven reset found the sentinel of `arms` arms present: none of them restores any more. Written on
	 * a finished operation too, by whoever holds the lease, since an open of the environment depends on it.
	 */
	async rewindVerified(id: string, arms: number, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET rewind_verified = ?, updated_at = ? WHERE id = ? AND rewind_arms = ? AND rewind_outcome IS NULL`,
			[arms, this.now(), id, arms],
			fence,
		)
	}

	/** A `verify` found the sentinel of `arms` arms gone: the object was rewound. Written on a finished operation too. */
	async rewindObserved(id: string, arms: number, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET rewind_outcome = 'rewound', rewind_verified = ?, updated_at = ?
				WHERE id = ? AND rewind_arms = ? AND rewind_outcome IS NULL`,
			[arms, this.now(), id, arms],
			fence,
		)
	}

	/** The environment's newest bookmark migration, in any state; `null` without one. */
	async latestBookmarkMigration(appId: string, env: string): Promise<DataOperationRow | null> {
		return await this.d1
			.prepare(`SELECT * FROM app_env_data_operations WHERE app_id = ? AND env = ? AND kind = 'migrate' AND records_bookmark = 1
				ORDER BY id DESC LIMIT 1`)
			.bind(appId, env)
			.first<DataOperationRow>()
	}

	/** The provider deployed a running bookmark migration's run. `false` once it finished, or off the lease. */
	async recordDeployed(id: string, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET deployed = 1, updated_at = ? WHERE id = ? AND state = 'running'`,
			[this.now(), id],
			fence,
		)
	}

	/** The bookmark migration that deploys `runId` as its own run, in any state; `null` for every other run. */
	async bookmarkMigrationOfRun(runId: string): Promise<DataOperationRow | null> {
		return await this.d1
			.prepare(`SELECT * FROM app_env_data_operations WHERE run_id = ? AND kind = 'migrate' AND records_bookmark = 1`)
			.bind(runId)
			.first<DataOperationRow>()
	}

	/** The bookmark migration of the environment that named `runId` as its rollback deploy; `null` for any other run. */
	async revertedBy(appId: string, env: string, runId: string): Promise<DataOperationRow | null> {
		return await this.d1
			.prepare('SELECT * FROM app_env_data_operations WHERE app_id = ? AND env = ? AND revert_run_id = ?')
			.bind(appId, env, runId)
			.first<DataOperationRow>()
	}

	/** A running operation succeeded. Terminal: `false` once it has finished or failed. */
	async finish(id: string, fence: LeaseFence, checkpoint?: BackupCheckpoint): Promise<boolean> {
		const now = this.now()
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET state = 'succeeded', updated_at = ?, finished_at = ? WHERE id = ? AND state = 'running'`,
			[now, now, id],
			fence,
			checkpoint,
		)
	}

	/** A running operation failed with `errorCode`. Terminal: `false` once it has finished or failed. */
	async fail(id: string, errorCode: string, fence: LeaseFence, checkpoint?: BackupCheckpoint): Promise<boolean> {
		if (!ERROR_CODE.test(errorCode)) throw new Error('a data operation error code is lowercase snake_case, at most 64 characters')
		const now = this.now()
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET state = 'failed', error_code = ?, updated_at = ?, finished_at = ? WHERE id = ? AND state = 'running'`,
			[errorCode, now, now, id],
			fence,
			checkpoint,
		)
	}

	/** As in `create`, the lease row stays locked through the write. */
	private lock(id: string, fence: LeaseFence) {
		return this.d1.prepare(`UPDATE deploy_locks SET holder = holder
			WHERE lock_key = (SELECT app_id || ':' || env FROM app_env_data_operations WHERE id = ?)
				AND holder = ? AND expires_at > ?`).bind(id, fence.holder, fence.nowMs)
	}

	private async mutate(id: string, sql: string, values: (string | number)[], fence: LeaseFence, checkpoint?: BackupCheckpoint): Promise<boolean> {
		const lock = this.lock(id, fence)
		if (checkpoint === undefined) {
			const results = await this.d1.batch<{ id: string }>([
				lock,
				this.d1.prepare(`${sql} AND ${operationLease} RETURNING id`).bind(...values, fence.holder, fence.nowMs),
			])
			return (results[1]?.results.length ?? 0) > 0
		}
		// The operation moves only once its backup's checkpoint is recorded, so neither write lands without the other.
		const { write, recorded } = backupCheckpoint(this.d1, checkpoint, this.now(), fence)
		const results = await this.d1.batch<{ id: string }>([
			lock,
			write,
			this.d1.prepare(`${sql} AND ${recorded.sql} AND ${operationLease} RETURNING id`).bind(...values, ...recorded.values, fence.holder, fence.nowMs),
		])
		return (results[2]?.results.length ?? 0) > 0
	}
}
