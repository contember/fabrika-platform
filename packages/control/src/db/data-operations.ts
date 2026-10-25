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
 * `serve`, `rewind`s the original and `check`s its schema; `revert` points traffic back at the original.
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
}

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
		| { kind: 'migrate'; runId: string }
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
						recovers_operation_id, resolution, run_id)
				SELECT ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, NULL, ?, ?, ?
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
		if (change.generation !== undefined) {
			sets.push('generation = ?')
			setValues.push(change.generation)
			where.push('generation < ?')
			whereValues.push(change.generation)
		}
		const sql = `UPDATE app_env_data_operations SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`
		if (change.objects === undefined) return await this.mutate(id, sql, [...setValues, ...whereValues], fence, checkpoint)
		if (checkpoint !== undefined) throw new Error('an advance records a backup checkpoint or the pointer, not both')
		// The pointer follows the operation's move in the same batch, and only once it moved under this lease.
		const results = await this.d1.batch<{ id: string }>([
			this.lock(id, fence),
			this.d1.prepare(`${sql} AND ${operationLease} RETURNING id`).bind(...setValues, ...whereValues, fence.holder, fence.nowMs),
			this.d1
				.prepare(`INSERT INTO app_env_application_objects (app_id, env, serving, listed, updated_at)
					SELECT app_id, env, ?, ?, ? FROM app_env_data_operations
					WHERE id = ? AND state = 'running' AND step = ? AND ${operationLease}
					ON CONFLICT (app_id, env) DO UPDATE SET serving = excluded.serving, listed = excluded.listed, updated_at = excluded.updated_at`)
				.bind(change.objects.serving, change.objects.listed.join(','), this.now(), id, change.step, fence.holder, fence.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
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
