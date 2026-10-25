import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
import type { LeaseFence } from '../lease'
import { firstRow } from './returning'

export type BackupState = 'running' | 'succeeded' | 'failed'

export type RehearsalOutcome = 'pending' | 'passed' | 'failed'

/** Where a rehearsal stands: `null` before its `begin` answered, then the import step it sends next. */
export type RehearsalStep = 'part' | 'link' | 'verify' | 'discard'

export interface BackupRow {
	id: string
	app_id: string
	env: string
	/** The `backup` or `migrate` data operation that takes it. */
	operation_id: string
	/** 1 for the backup a migration phase takes before its deploy, 0 for a daily one. */
	pre_migration: number
	/** The object the dump is taken from. */
	object: string
	/** The dump id: a UUIDv7 Control generates, which keys the dump in the environment's bucket; a restarted dump gets a new one. */
	dump_id: string
	/** The generation the export's `begin` ran at; `null` before it answered. The exporter binds the dump to it. */
	dump_generation: number | null
	/** `succeeded` only once the rehearsal passed. */
	state: BackupState
	/** A code once failed; never free text. */
	error_code: string | null
	created_at: number
	finished_at: number | null
	/** The object's bookmark at the export's `begin`; `null` before it answered. */
	bookmark: string | null
	/** The multipart upload of the data; `null` before `begin` answered. */
	upload_id: string | null
	/** The data object's size, once the upload completed. */
	size_bytes: number | null
	/** How many parts the data object holds, once the upload completed. */
	parts: number | null
	/** How many tables the manifest lists, once the upload completed. */
	tables: number | null
	rehearsal: RehearsalOutcome
	/** The code the rehearsal failed with; never free text. */
	rehearsal_code: string | null
	rehearsal_step: RehearsalStep | null
	/** The part count the import's `begin` answered. */
	rehearsal_parts: number | null
	/** The last verify answer, as the object gave it; read again with the wire's parser. */
	rehearsal_cursor: string | null
}

export interface BackupPartRow {
	backup_id: string
	part: number
	/** The export's part answer, as the object gave it; read again with the wire's parser. */
	ack: string
	/** The rows with a deferred key the rehearsal loaded from this part; `null` before it loaded the part. */
	deferred: number | null
	/** 1 once the rehearsal set this part's deferred keys. */
	linked: number
}

export interface BackupScheduleRow {
	app_id: string
	env: string
	/** 1 while daily backups run, the default; 0 once the environment opted out. */
	daily: number
	actor: string
	updated_at: number
}

export interface BackupInput {
	id: string
	appId: string
	env: string
	operationId: string
	object: string
	/** Taken by a migration phase before its deploy. */
	preMigration: boolean
}

/** The completed upload, as its manifest describes it. */
export interface BackupCompletion {
	sizeBytes: number
	parts: number
	tables: number
}

export interface RehearsalProgress {
	step: RehearsalStep
	parts?: number
	cursor?: string
}

/** When an environment's newest succeeded backup began, and when its newest failed one ended; `null` while there is none. */
export interface BackupHistory {
	lastSucceeded: number | null
	lastFailed: number | null
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/

/** The lease row a backup's writes hold, derived from the backup row they write. */
const backupLease = `EXISTS (SELECT 1 FROM deploy_locks
	WHERE lock_key = app_env_backups.app_id || ':' || app_env_backups.env AND holder = ? AND expires_at > ?)`

/**
 * A backup's terminal record, written in one batch with its operation's next step or end
 * (`DataOperationRepository.advance`, `finish`, `fail`), so no crash leaves one without the other.
 */
export type BackupCheckpoint =
	| { readonly backupId: string; readonly outcome: 'failed'; readonly code: string }
	| { readonly backupId: string; readonly outcome: 'rehearsal_failed'; readonly code: string }
	| { readonly backupId: string; readonly outcome: 'succeeded' }

/**
 * The fenced statement that records `checkpoint` on a running backup, and the condition that holds once it is recorded,
 * which the operation's write in the same batch requires. A checkpoint already recorded writes nothing and still holds.
 */
export function backupCheckpoint(
	d1: SqlDatabase,
	checkpoint: BackupCheckpoint,
	now: number,
	fence: LeaseFence,
): { readonly write: SqlStatement; readonly recorded: { readonly sql: string; readonly values: readonly string[] } } {
	const { backupId } = checkpoint
	switch (checkpoint.outcome) {
		case 'failed':
			assertCode(checkpoint.code)
			return {
				write: d1.prepare(`UPDATE app_env_backups SET state = 'failed', error_code = ?, finished_at = ? WHERE id = ? AND state = 'running'
					AND ${backupLease} RETURNING id`).bind(checkpoint.code, now, backupId, fence.holder, fence.nowMs),
				recorded: { sql: `EXISTS (SELECT 1 FROM app_env_backups WHERE id = ? AND state = 'failed')`, values: [backupId] },
			}
		case 'rehearsal_failed':
			assertCode(checkpoint.code)
			return {
				write: d1.prepare(`UPDATE app_env_backups
					SET state = 'failed', error_code = 'rehearsal_failed', rehearsal = 'failed', rehearsal_code = ?, finished_at = ?
					WHERE id = ? AND state = 'running' AND ${backupLease} RETURNING id`).bind(checkpoint.code, now, backupId, fence.holder, fence.nowMs),
				recorded: { sql: `EXISTS (SELECT 1 FROM app_env_backups WHERE id = ? AND state = 'failed' AND rehearsal = 'failed')`, values: [backupId] },
			}
		case 'succeeded':
			return {
				write: d1.prepare(`UPDATE app_env_backups SET state = 'succeeded', rehearsal = 'passed', finished_at = ? WHERE id = ? AND state = 'running'
					AND ${backupLease} RETURNING id`).bind(now, backupId, fence.holder, fence.nowMs),
				recorded: { sql: `EXISTS (SELECT 1 FROM app_env_backups WHERE id = ? AND state = 'succeeded')`, values: [backupId] },
			}
	}
}

/**
 * Control's record of an environment's consistent backups (ADR-0070) and their daily schedule. Every write of a backup
 * or its parts is fenced on the environment's deploy lease in the same statement, as the operation that takes it is.
 */
export class BackupRepository {
	constructor(private readonly d1: SqlDatabase, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	/** Records a running backup of a running operation; `null` when `fence` does not hold the environment's lease. */
	async create(input: BackupInput, fence: LeaseFence): Promise<BackupRow | null> {
		const key = `${input.appId}:${input.env}`
		const results = await this.d1.batch<BackupRow>([
			this.d1.prepare('UPDATE deploy_locks SET holder = holder WHERE lock_key = ? AND holder = ? AND expires_at > ?').bind(
				key,
				fence.holder,
				fence.nowMs,
			),
			this.d1
				.prepare(`INSERT INTO app_env_backups
					(id, app_id, env, operation_id, object, dump_id, dump_generation, pre_migration, state, error_code, created_at, finished_at,
						bookmark, upload_id, size_bytes, parts, tables, rehearsal, rehearsal_code, rehearsal_step, rehearsal_parts, rehearsal_cursor)
				SELECT ?, ?, ?, ?, ?, ?, NULL, ?, 'running', NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'pending', NULL, NULL, NULL, NULL
				WHERE EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)
				RETURNING *`)
				.bind(
					input.id,
					input.appId,
					input.env,
					input.operationId,
					input.object,
					// The first dump takes the backup's own id.
					input.id,
					input.preMigration ? 1 : 0,
					this.now(),
					key,
					fence.holder,
					fence.nowMs,
				),
		])
		return results[1]?.results[0] ?? null
	}

	async get(id: string): Promise<BackupRow | null> {
		return await this.d1.prepare('SELECT * FROM app_env_backups WHERE id = ?').bind(id).first<BackupRow>()
	}

	async getForOperation(operationId: string): Promise<BackupRow | null> {
		return await this.d1.prepare('SELECT * FROM app_env_backups WHERE operation_id = ?').bind(operationId).first<BackupRow>()
	}

	/** Newest first. `id` is UUIDv7, so `before` is a sound keyset cursor. */
	async listForEnvironment(appId: string, env: string, page: { before?: string; limit: number }): Promise<BackupRow[]> {
		const before = page.before === undefined ? '' : ' AND id < ?'
		const binds = page.before === undefined ? [appId, env, page.limit] : [appId, env, page.before, page.limit]
		const { results } = await this.d1
			.prepare(`SELECT * FROM app_env_backups WHERE app_id = ? AND env = ?${before} ORDER BY id DESC LIMIT ?`)
			.bind(...binds)
			.all<BackupRow>()
		return results
	}

	async history(appId: string, env: string): Promise<BackupHistory> {
		const row = await firstRow<{ last_succeeded: number | null; last_failed: number | null }>(
			this.d1
				.prepare(`SELECT MAX(CASE WHEN state = 'succeeded' THEN created_at END) AS last_succeeded,
						MAX(CASE WHEN state = 'failed' THEN finished_at END) AS last_failed
					FROM app_env_backups WHERE app_id = ? AND env = ?`)
				.bind(appId, env),
		)
		return { lastSucceeded: row.last_succeeded, lastFailed: row.last_failed }
	}

	/** Every part recorded so far, in order. */
	async parts(id: string): Promise<BackupPartRow[]> {
		const { results } = await this.d1.prepare('SELECT * FROM app_env_backup_parts WHERE backup_id = ? ORDER BY part').bind(id).all<BackupPartRow>()
		return results
	}

	/** The export's `begin` answered at `generation`: the upload it started and the object's bookmark. */
	async begun(id: string, upload: { uploadId: string; bookmark: string; generation: number }, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(
			id,
			'UPDATE app_env_backups SET upload_id = ?, bookmark = ?, dump_generation = ? WHERE id = ? AND state = ? AND upload_id IS NULL',
			[upload.uploadId, upload.bookmark, upload.generation, id, 'running'],
			fence,
		)
	}

	/**
	 * Starts the unfinished dump again under `dumpId`: its upload, bookmark, generation and recorded parts are dropped. The
	 * old upload is abandoned, never completed, so nothing reads it.
	 */
	async restart(id: string, dumpId: string, fence: LeaseFence): Promise<boolean> {
		const results = await this.d1.batch<{ id: string }>([
			this.lockLease(id, fence),
			this.d1
				.prepare(`DELETE FROM app_env_backup_parts WHERE backup_id = ?
					AND EXISTS (SELECT 1 FROM app_env_backups WHERE id = ? AND state = 'running' AND parts IS NULL AND ${backupLease})`)
				.bind(id, id, fence.holder, fence.nowMs),
			this.d1
				.prepare(`UPDATE app_env_backups SET dump_id = ?, upload_id = NULL, bookmark = NULL, dump_generation = NULL
					WHERE id = ? AND state = 'running' AND parts IS NULL AND ${backupLease} RETURNING id`)
				.bind(dumpId, id, fence.holder, fence.nowMs),
		])
		return (results[2]?.results.length ?? 0) > 0
	}

	/** Records part `part` with the answer that uploaded it; `false` when the lease or the backup's state is not as expected. */
	async addPart(id: string, part: number, ack: string, fence: LeaseFence): Promise<boolean> {
		const results = await this.d1.batch<{ part: number }>([
			this.lockLease(id, fence),
			this.d1
				.prepare(`INSERT INTO app_env_backup_parts (backup_id, part, ack, deferred, linked)
					SELECT id, ?, ?, NULL, 0 FROM app_env_backups WHERE id = ? AND state = 'running' AND parts IS NULL AND ${backupLease}
					RETURNING part`)
				.bind(part, ack, id, fence.holder, fence.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
	}

	async completed(id: string, completion: BackupCompletion, fence: LeaseFence): Promise<boolean> {
		return await this.mutate(id, 'UPDATE app_env_backups SET size_bytes = ?, parts = ?, tables = ? WHERE id = ? AND state = ? AND parts IS NULL', [
			completion.sizeBytes,
			completion.parts,
			completion.tables,
			id,
			'running',
		], fence)
	}

	/** Moves the rehearsal to `progress.step`, with the part count `begin` answered or the last verify answer. */
	async rehearse(id: string, progress: RehearsalProgress, fence: LeaseFence): Promise<boolean> {
		const sets = ['rehearsal_step = ?']
		const values: (string | number)[] = [progress.step]
		if (progress.parts !== undefined) {
			sets.push('rehearsal_parts = ?')
			values.push(progress.parts)
		}
		if (progress.cursor !== undefined) {
			sets.push('rehearsal_cursor = ?')
			values.push(progress.cursor)
		}
		return await this.mutate(id, `UPDATE app_env_backups SET ${sets.join(', ')} WHERE id = ? AND state = ? AND parts IS NOT NULL`, [
			...values,
			id,
			'running',
		], fence)
	}

	/** The rehearsal loaded part `part`, with `deferred` rows whose keys wait for the link pass. */
	async partLoaded(id: string, part: number, deferred: number, fence: LeaseFence): Promise<boolean> {
		return await this.mutatePart(id, part, 'deferred = ?', [deferred], fence)
	}

	async partLinked(id: string, part: number, fence: LeaseFence): Promise<boolean> {
		return await this.mutatePart(id, part, 'linked = 1', [], fence)
	}

	/**
	 * Records a terminal checkpoint on its own: the rehearsal passed, the dump was not taken, or its rehearsal failed. An
	 * operation records one with its own step instead (`BackupCheckpoint`). `false` unless it changed a running backup.
	 */
	async settle(checkpoint: BackupCheckpoint, fence: LeaseFence): Promise<boolean> {
		const { write } = backupCheckpoint(this.d1, checkpoint, this.now(), fence)
		const results = await this.d1.batch<{ id: string }>([this.lockLease(checkpoint.backupId, fence), write])
		return (results[1]?.results.length ?? 0) > 0
	}

	async getSchedule(appId: string, env: string): Promise<BackupScheduleRow | null> {
		return await this.d1.prepare('SELECT * FROM app_env_backup_schedules WHERE app_id = ? AND env = ?').bind(appId, env).first<BackupScheduleRow>()
	}

	/** Sets whether the environment takes daily backups. Fails on the foreign key when the environment does not exist. */
	async setSchedule(appId: string, env: string, daily: boolean, actor: string): Promise<BackupScheduleRow> {
		return await firstRow<BackupScheduleRow>(
			this.d1
				.prepare(`INSERT INTO app_env_backup_schedules (app_id, env, daily, actor, updated_at) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (app_id, env) DO UPDATE SET daily = excluded.daily, actor = excluded.actor, updated_at = excluded.updated_at
					RETURNING *`)
				.bind(appId, env, daily ? 1 : 0, actor, this.now()),
		)
	}

	private lockLease(id: string, fence: LeaseFence) {
		// As in the operation record, the lease row stays locked through the write: an EXISTS alone races a takeover on Postgres.
		return this.d1.prepare(`UPDATE deploy_locks SET holder = holder
			WHERE lock_key = (SELECT app_id || ':' || env FROM app_env_backups WHERE id = ?) AND holder = ? AND expires_at > ?`).bind(
			id,
			fence.holder,
			fence.nowMs,
		)
	}

	private async mutate(id: string, sql: string, values: (string | number)[], fence: LeaseFence): Promise<boolean> {
		const results = await this.d1.batch<{ id: string }>([
			this.lockLease(id, fence),
			this.d1.prepare(`${sql} AND ${backupLease} RETURNING id`).bind(...values, fence.holder, fence.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
	}

	private async mutatePart(id: string, part: number, set: string, values: number[], fence: LeaseFence): Promise<boolean> {
		const results = await this.d1.batch<{ part: number }>([
			this.lockLease(id, fence),
			this.d1
				.prepare(`UPDATE app_env_backup_parts SET ${set} WHERE backup_id = ? AND part = ?
					AND EXISTS (SELECT 1 FROM app_env_backups WHERE app_env_backups.id = app_env_backup_parts.backup_id
						AND app_env_backups.state = 'running' AND ${backupLease})
					RETURNING part`)
				.bind(...values, id, part, fence.holder, fence.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
	}
}

function assertCode(code: string): void {
	if (!CODE.test(code)) throw new Error('a backup code is lowercase snake_case, at most 64 characters')
}
