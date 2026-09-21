import type { SqlDatabase } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import { firstRow } from './returning'

export type RunTrigger = 'webhook' | 'manual' | 'poll'

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface RunRow {
	id: string
	app_id: string
	env: string
	ref: string
	commit_sha: string | null
	trigger: RunTrigger
	status: RunStatus
	exit_code: number | null
	/** R2 key the relay streams the run's log into (runs/<id>/logs.ndjson). */
	log_key: string | null
	created_at: number
	started_at: number | null
	finished_at: number | null
	/** Provider-owned operation id, persisted as soon as the provider accepts asynchronous work. */
	external_run_id: string | null
	/** Credential-free provider-owned progress, validated before writes and reads. */
	provider_state_json: string | null
	/** Set while cancellation owns provider cleanup and blocks ordinary lifecycle writes. */
	cancel_requested_at: number | null
}

const isJsonValue = (value: unknown, seen: WeakSet<object> = new WeakSet()): value is JsonValue => {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
	if (typeof value === 'number') return Number.isFinite(value)
	if (typeof value !== 'object' || seen.has(value)) return false
	if (!Array.isArray(value)) {
		const prototype: unknown = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return false
		if (Reflect.ownKeys(value).length !== Object.keys(value).length) return false
	}
	seen.add(value)
	const valid = Array.isArray(value)
		? value.every((entry) => isJsonValue(entry, seen))
		: Object.values(value).every((entry) => isJsonValue(entry, seen))
	seen.delete(value)
	return valid
}

const MAX_PROVIDER_STATE_BYTES = 16 * 1024

/** Parse provider-owned JSON without trusting persisted database text. */
export const parseProviderJson = (raw: string, label: string): JsonValue => {
	if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_STATE_BYTES) throw new Error(`${label} exceeds 16 KiB`)
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		throw new Error(`${label} is not valid JSON`)
	}
	if (!isJsonValue(value)) throw new Error(`${label} is not a JSON value`)
	return value
}

const serializeProviderJson = (value: JsonValue): string => {
	if (!isJsonValue(value)) throw new Error('provider checkpoint is not a JSON value')
	const serialized = JSON.stringify(value)
	if (typeof serialized !== 'string') throw new Error('provider checkpoint is not serializable')
	if (new TextEncoder().encode(serialized).byteLength > MAX_PROVIDER_STATE_BYTES) throw new Error('provider checkpoint exceeds 16 KiB')
	return serialized
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export class RunRepository {
	constructor(protected readonly d1: SqlDatabase, protected readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	/** Create a run row in `pending`, ready to be enqueued. Returns the inserted row. */
	async createRun(input: {
		id: string
		appId: string
		env: string
		ref: string
		commitSha?: string | null
		trigger: RunTrigger
	}): Promise<RunRow> {
		return firstRow<RunRow>(
			this.d1
				.prepare(`INSERT INTO runs (id, app_id, env, ref, commit_sha, trigger, status)
					VALUES (?, ?, ?, ?, ?, ?, 'pending') RETURNING *`)
				.bind(input.id, input.appId, input.env, input.ref, input.commitSha ?? null, input.trigger),
		)
	}

	async getRun(id: string): Promise<RunRow | null> {
		return this.d1.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>()
	}

	/** Persist a provider-owned operation id and optional resume state in one guarded write. */
	async setRunExternalId(id: string, externalRunId: string, providerState?: JsonValue): Promise<boolean> {
		const statement = providerState === undefined
			? this.d1.prepare(`UPDATE runs SET external_run_id = ?
				WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
					AND (external_run_id IS NULL OR external_run_id = ?)`)
				.bind(externalRunId, id, externalRunId)
			: this.d1
				.prepare(`UPDATE runs SET external_run_id = ?, provider_state_json = ?
					WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
						AND (external_run_id IS NULL OR external_run_id = ?)`)
				.bind(externalRunId, serializeProviderJson(providerState), id, externalRunId)
		const result = await statement.run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Replace provider resume state only while the run remains active. */
	async checkpointRunProviderState(id: string, providerState: JsonValue): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE runs SET provider_state_json = ?
				WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL AND external_run_id IS NOT NULL`)
			.bind(serializeProviderJson(providerState), id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Pending/running runs whose work is owned by a provider and must survive process restarts. */
	async listInFlightRuns(provider: string): Promise<RunRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT r.* FROM runs r
				JOIN app_envs e ON e.app_id = r.app_id AND e.env = r.env
				WHERE e.provider = ? AND r.status IN ('pending', 'running')
				ORDER BY r.id`)
			.bind(provider)
			.all<RunRow>()
		return results
	}

	/**
	 * List runs, newest first, optionally filtered by app and/or env. `id` is UUIDv7 with the RFC 9562
	 * §6.2 monotonic counter (`src/uuid.ts`), so a TEXT `ORDER BY id DESC` is chronological down to the
	 * individual mint — two runs created in the SAME millisecond still order by which was created
	 * first. That is what makes `before` a sound keyset cursor: no page can skip or repeat a row.
	 */
	async listRuns(filter: { appId?: string; env?: string; before?: string; limit: number }): Promise<RunRow[]> {
		const where: string[] = []
		const binds: (string | number)[] = []
		if (filter.appId !== undefined) {
			where.push('app_id = ?')
			binds.push(filter.appId)
		}
		if (filter.env !== undefined) {
			where.push('env = ?')
			binds.push(filter.env)
		}
		if (filter.before !== undefined) {
			where.push('id < ?')
			binds.push(filter.before)
		}
		const sql = `SELECT * FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
		binds.push(filter.limit)
		const { results } = await this.d1.prepare(sql).bind(...binds).all<RunRow>()
		return results
	}

	/**
	 * Move a run `pending → running`: stamp `started_at` and the R2 log key. Guarded on the current
	 * status so a redelivered queue message can't re-start a run already past pending. Returns true
	 * iff the row transitioned.
	 */
	async markRunStarted(id: string, logKey: string): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE runs SET status = 'running', started_at = ?, log_key = ?
				WHERE id = ? AND status = 'pending' AND cancel_requested_at IS NULL`)
			.bind(this.now(), logKey, id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Record one resolved commit while the active run still accepts provider lifecycle writes. */
	async setRunCommit(id: string, commitSha: string): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE runs SET commit_sha = ?
				WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
					AND (commit_sha IS NULL OR LOWER(commit_sha) = ?)`)
			.bind(commitSha, id, commitSha)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Atomically claim cancellation and return the latest active run snapshot. */
	async beginRunCancellation(id: string): Promise<RunRow | null> {
		return this.d1
			.prepare(`UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?)
				WHERE id = ? AND status IN ('pending','running') RETURNING *`)
			.bind(this.now(), id)
			.first<RunRow>()
	}

	/**
	 * Move a run to a terminal state (`succeeded` | `failed`): stamp `finished_at` + the exit code.
	 * Returns true iff the row transitioned (it was still `running`/`pending`).
	 *
	 * The statement + bind order are DUPLICATED verbatim by `@fabrika/runner-cloudflare`'s `finishRun`, whose
	 * co-write the `WHERE status IN ('pending','running')` guard makes idempotent. Change both together.
	 */
	async markRunFinished(id: string, status: 'succeeded' | 'failed', exitCode: number | null): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE runs SET status = ?, exit_code = ?, finished_at = ?
				WHERE id = ? AND status IN ('pending','running') AND cancel_requested_at IS NULL`)
			.bind(status, exitCode, this.now(), id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/**
	 * The runner's `finishRun` records `succeeded` inside `startRun`, before control applies the IAM reconcile; this
	 * is the one succeeded→failed correction that a later failure needs. Keeps `finished_at`, refuses a cancelled run.
	 */
	async markRunFailedAfterRunner(id: string): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE runs SET status = 'failed', exit_code = NULL
				WHERE id = ? AND status = 'succeeded' AND cancel_requested_at IS NULL`)
			.bind(id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Finish a run only after cancellation has durably claimed and completed provider cleanup. */
	async markRunCancellationFinished(id: string): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE runs SET status = 'failed', exit_code = NULL, finished_at = ?
				WHERE id = ? AND status IN ('pending','running') AND cancel_requested_at IS NOT NULL`)
			.bind(this.now(), id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/**
	 * Sweep ORPHANED runs: mark any still `pending`/`running` past `maxAgeSeconds` as `failed`. vozka-runner's
	 * per-run backstop (RunnerContainer DO) already records the terminal status within ~18 min even when the
	 * relay is aborted (e.g. a fabrika self-deploy resets fabrika mid-run) — this cron-driven sweep is the
	 * backstop-TO-the-backstop for the rare case the DO never fired at all (e.g. vozka-runner itself was
	 * down). Aged on `started_at` (running) falling back to `created_at` (never-started pending). Returns
	 * the count swept. `maxAgeSeconds` must comfortably exceed the container hard-kill (~15 min) + backstop
	 * deadline (~18 min) so a genuinely in-flight run is never reaped.
	 */
	async sweepStaleRuns(maxAgeSeconds: number): Promise<number> {
		// One clock read for both the cutoff and the stamp, so a sweep can never reap by a later `now`
		// than the one it records.
		const now = this.now()
		const result = await this.d1
			.prepare(`UPDATE runs SET status = 'failed', finished_at = ?
				WHERE status IN ('pending','running')
					AND cancel_requested_at IS NULL
					AND COALESCE(started_at, created_at) < ?
					AND external_run_id IS NULL`)
			.bind(now, now - maxAgeSeconds)
			.run()
		return result.meta.changes ?? 0
	}
}
