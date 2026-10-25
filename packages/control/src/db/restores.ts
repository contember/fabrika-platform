import type { SqlDatabase } from '@fabrika/platform'
import { type LeaseFence, runLeaseKey } from '../lease'

/** The pointer as Control records it: the object of ordinary traffic and the objects the ops channel reaches. */
export interface ApplicationObjectsRow {
	app_id: string
	env: string
	serving: string
	/** Names joined by `,`, `serving` among them. */
	listed: string
	updated_at: number
}

/** One side restore's record (ADR-0070 §9), beside its `restore` data operation. */
export interface RestoreRow {
	operation_id: string
	app_id: string
	env: string
	/** The target time, ISO 8601 in UTC. */
	at: string
	/** The object the restore freezes, backs up and rewinds: the one serving when it started. */
	original: string
	/** The object the backup is imported into, which then serves: `application-<operation id>`. */
	clone: string
	list_run_id: string | null
	point_run_id: string | null
	revert_run_id: string | null
	/** The original's bookmark when `prepare` ran, and the bookmark of `at`; both recorded before any `arm`. */
	current_bookmark: string | null
	target_bookmark: string | null
	/** The bookmark an `arm` answered, which undoes the rewind; `null` while no answer arrived. */
	undo_bookmark: string | null
	/** How many `arm`s were sent, counted before each is sent. */
	arms: number
	/** The code the operation fails with once the original is open again; `null` while nothing failed. */
	failure: string | null
	created_at: number
}

/** Which deploy of a restore a run belongs to: the listing, the pointer, or the pointer back to the original. */
export type RestoreDeploy = 'list' | 'point' | 'revert'

const CODE = /^[a-z][a-z0-9_]{0,63}$/

/** The lease row a write of an environment's row holds, derived from the row it writes. */
const lease = (table: string): string =>
	`EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ${table}.app_id || ':' || ${table}.env AND holder = ? AND expires_at > ?)`

/**
 * The pointer every deploy of a release that serves ops writes as `FABRIKA_APPLICATION_OBJECT(S)` (ADR-0070 §9). Only a
 * restore moves it, fenced on the environment's deploy lease in the same statement.
 */
export class ApplicationObjectsRepository {
	constructor(private readonly d1: SqlDatabase, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	/** `null` while no restore moved it: the defaults. */
	async get(appId: string, env: string): Promise<ApplicationObjectsRow | null> {
		return await this.d1.prepare('SELECT * FROM app_env_application_objects WHERE app_id = ? AND env = ?').bind(appId, env).first<
			ApplicationObjectsRow
		>()
	}

	/** Records the pointer; `false` when `fence` does not hold the environment's lease. */
	async set(appId: string, env: string, objects: { serving: string; listed: readonly string[] }, fence: LeaseFence): Promise<boolean> {
		const key = runLeaseKey(appId, env)
		const results = await this.d1.batch<{ app_id: string }>([
			this.d1.prepare('UPDATE deploy_locks SET holder = holder WHERE lock_key = ? AND holder = ? AND expires_at > ?').bind(
				key,
				fence.holder,
				fence.nowMs,
			),
			this.d1
				.prepare(`INSERT INTO app_env_application_objects (app_id, env, serving, listed, updated_at)
					SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)
					ON CONFLICT (app_id, env) DO UPDATE SET serving = excluded.serving, listed = excluded.listed, updated_at = excluded.updated_at
					RETURNING app_id`)
				.bind(appId, env, objects.serving, objects.listed.join(','), this.now(), key, fence.holder, fence.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
	}
}

export interface RestoreInput {
	operationId: string
	appId: string
	env: string
	at: string
	original: string
	clone: string
}

/** A restore's record. Every write is fenced on the environment's deploy lease in the same statement, as its operation's are. */
export class RestoreRepository {
	constructor(private readonly d1: SqlDatabase, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	/** Records the restore of a running operation; `null` when `fence` does not hold the environment's lease. */
	async create(input: RestoreInput, fence: LeaseFence): Promise<RestoreRow | null> {
		const key = runLeaseKey(input.appId, input.env)
		const results = await this.d1.batch<RestoreRow>([
			this.d1.prepare('UPDATE deploy_locks SET holder = holder WHERE lock_key = ? AND holder = ? AND expires_at > ?').bind(
				key,
				fence.holder,
				fence.nowMs,
			),
			this.d1
				.prepare(`INSERT INTO app_env_restores (operation_id, app_id, env, at, original, clone, arms, created_at)
					SELECT ?, ?, ?, ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)
					RETURNING *`)
				.bind(input.operationId, input.appId, input.env, input.at, input.original, input.clone, this.now(), key, fence.holder, fence.nowMs),
		])
		return results[1]?.results[0] ?? null
	}

	async get(operationId: string): Promise<RestoreRow | null> {
		return await this.d1.prepare('SELECT * FROM app_env_restores WHERE operation_id = ?').bind(operationId).first<RestoreRow>()
	}

	/** Names the run of one of its deploys, once: a run already named stays. */
	async nameRun(operationId: string, deploy: RestoreDeploy, runId: string, fence: LeaseFence): Promise<boolean> {
		const column = `${deploy}_run_id`
		return await this.mutate(operationId, { sql: `${column} = ?`, values: [runId] }, { sql: `${column} IS NULL`, values: [] }, fence)
	}

	/** Records what `prepare` answered, once, before anything is armed. */
	async prepared(operationId: string, bookmarks: { current: string; target: string }, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			operationId,
			{ sql: 'current_bookmark = ?, target_bookmark = ?', values: [bookmarks.current, bookmarks.target] },
			{ sql: 'target_bookmark IS NULL', values: [] },
			fence,
		)
	}

	/** Counts an `arm` before it is sent, so a successor never takes an unanswered one for an unsent one. */
	async arming(operationId: string, arms: number, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			operationId,
			{ sql: 'arms = ?', values: [arms + 1] },
			{ sql: 'arms = ? AND target_bookmark IS NOT NULL', values: [arms] },
			fence,
		)
	}

	async armed(operationId: string, undo: string, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(operationId, { sql: 'undo_bookmark = ?', values: [undo] }, { sql: 'arms > 0', values: [] }, fence)
	}

	/** Records the code the operation fails with once the original is open again; the first one recorded stays. */
	async failed(operationId: string, code: string, fence: LeaseFence): Promise<boolean> {
		if (!CODE.test(code)) throw new Error('a restore failure is a code: lowercase snake_case, at most 64 characters')
		return await this.mutate(operationId, { sql: 'failure = ?', values: [code] }, { sql: 'failure IS NULL', values: [] }, fence)
	}

	/** One fenced update of the restore; `false` when the lease or the precondition does not hold. */
	private async mutate(operationId: string, set: Clause, precondition: Clause, fence: LeaseFence): Promise<boolean> {
		const results = await this.d1.batch<{ operation_id: string }>([
			this.d1.prepare(`UPDATE deploy_locks SET holder = holder
				WHERE lock_key = (SELECT app_id || ':' || env FROM app_env_restores WHERE operation_id = ?) AND holder = ? AND expires_at > ?`)
				.bind(operationId, fence.holder, fence.nowMs),
			this.d1
				.prepare(`UPDATE app_env_restores SET ${set.sql}
					WHERE operation_id = ? AND ${precondition.sql} AND ${lease('app_env_restores')} RETURNING operation_id`)
				.bind(...set.values, operationId, ...precondition.values, fence.holder, fence.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
	}
}

interface Clause {
	readonly sql: string
	readonly values: readonly (string | number)[]
}
