import type { SqlDatabase } from '@fabrika/platform'
import { type LeaseFence, runLeaseKey } from '../lease'
import { firstRow } from './returning'

/** What an environment's object admits (ADR-0069 §3). */
export type MaintenanceMode = 'open' | 'read-only' | 'closed' | 'inspect'

export type DataOperationKind = 'maintenance' | 'backup' | 'migrate' | 'recovery' | 'restore'

/**
 * `restrict` and `open` publish a generation; `backup`, `verify`, `deploy` and `migrate` run between them. A recovery
 * first `reconcile`s the record with the object's published state, and `resume` hands back to the interrupted operation.
 */
export type DataOperationStep = 'reconcile' | 'restrict' | 'backup' | 'verify' | 'deploy' | 'migrate' | 'resume' | 'open'

export type DataOperationState = 'running' | 'succeeded' | 'failed'

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
	actor: string
	created_at: number
	updated_at: number
	finished_at: number | null
}

export interface DataOperationInput {
	id: string
	appId: string
	env: string
	kind: DataOperationKind
	step: DataOperationStep
	targetMode: MaintenanceMode
	/** Allocated by `allocateGeneration` before the operation sends any request under it. */
	generation: number
	actor: string
}

export interface DataOperationAdvance {
	/** The step the caller read; another one means it lost a race and nothing changes. */
	expectedStep: DataOperationStep
	step: DataOperationStep
	targetMode?: MaintenanceMode
	/** A freshly allocated generation, above the recorded one. */
	generation?: number
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

	/** Records a running operation; `null` when `fence` does not hold the environment's lease. */
	async create(input: DataOperationInput, fence: LeaseFence): Promise<DataOperationRow | null> {
		const key = runLeaseKey(input.appId, input.env)
		const now = this.now()
		// The lease row must stay locked through the write: an EXISTS alone races a takeover on Postgres.
		const results = await this.d1.batch<DataOperationRow>([
			this.d1.prepare('UPDATE deploy_locks SET holder = holder WHERE lock_key = ? AND holder = ? AND expires_at > ?').bind(
				key,
				fence.holder,
				fence.nowMs,
			),
			this.d1
				.prepare(`INSERT INTO app_env_data_operations
					(id, app_id, env, kind, step, target_mode, generation, state, error_code, actor, created_at, updated_at, finished_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, NULL
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
					key,
					fence.holder,
					fence.nowMs,
				),
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

	/** Moves a running operation from `expectedStep` to the next. `false`: the lease, the step or the state was not as expected. */
	async advance(id: string, change: DataOperationAdvance, fence: LeaseFence): Promise<boolean> {
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
		return await this.mutate(id, `UPDATE app_env_data_operations SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`, [
			...setValues,
			...whereValues,
		], fence)
	}

	/** A running operation succeeded. Terminal: `false` once it has finished or failed. */
	async finish(id: string, fence: LeaseFence): Promise<boolean> {
		const now = this.now()
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET state = 'succeeded', updated_at = ?, finished_at = ? WHERE id = ? AND state = 'running'`,
			[now, now, id],
			fence,
		)
	}

	/** A running operation failed with `errorCode`. Terminal: `false` once it has finished or failed. */
	async fail(id: string, errorCode: string, fence: LeaseFence): Promise<boolean> {
		if (!ERROR_CODE.test(errorCode)) throw new Error('a data operation error code is lowercase snake_case, at most 64 characters')
		const now = this.now()
		return await this.mutate(
			id,
			`UPDATE app_env_data_operations SET state = 'failed', error_code = ?, updated_at = ?, finished_at = ? WHERE id = ? AND state = 'running'`,
			[errorCode, now, now, id],
			fence,
		)
	}

	private async mutate(id: string, sql: string, values: (string | number)[], fence: LeaseFence): Promise<boolean> {
		// As in `create`, the lease row stays locked through the write.
		const results = await this.d1.batch<{ id: string }>([
			this.d1.prepare(`UPDATE deploy_locks SET holder = holder
				WHERE lock_key = (SELECT app_id || ':' || env FROM app_env_data_operations WHERE id = ?)
					AND holder = ? AND expires_at > ?`).bind(id, fence.holder, fence.nowMs),
			this.d1.prepare(`${sql} AND ${operationLease} RETURNING id`).bind(...values, fence.holder, fence.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
	}
}
