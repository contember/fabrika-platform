import type { SqlDatabase } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import { firstRow } from './returning'

export type RunTrigger = 'webhook' | 'manual' | 'poll'

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed'

/** Acquire the lease first with a unique invocation holder; sample nowMs anew for each mutation. */
export interface RunMutationGuard {
	readonly holder: string
	readonly nowMs: number
	readonly expectedProviderStateJson: string | null
}

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
	/** Durable cancellation request; blocks ordinary lifecycle writes until an invocation settles it. */
	cancel_requested_at: number | null
}

// Serialization must reject cycles, non-plain objects and hidden keys before JSON.stringify can erase them.
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

export const serializeProviderJson = (value: JsonValue): string => {
	if (!isJsonValue(value)) throw new Error('provider checkpoint is not a JSON value')
	const serialized = JSON.stringify(value)
	if (typeof serialized !== 'string') throw new Error('provider checkpoint is not serializable')
	if (new TextEncoder().encode(serialized).byteLength > MAX_PROVIDER_STATE_BYTES) throw new Error('provider checkpoint exceeds 16 KiB')
	return serialized
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export class RunRepository {
	constructor(protected readonly d1: SqlDatabase, protected readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	private async mutateRun(id: string, sql: string, values: (string | number | null)[], guard?: RunMutationGuard): Promise<boolean> {
		if (guard === undefined) {
			const result = await this.d1.prepare(sql).bind(...values).run()
			return result.meta.changes > 0
		}
		const checkpointPredicate = guard.expectedProviderStateJson === null ? 'provider_state_json IS NULL' : 'provider_state_json = ?'
		const checkpointValues = guard.expectedProviderStateJson === null ? [] : [guard.expectedProviderStateJson]
		// The lease row must stay locked through the mutation: an EXISTS alone races takeover on Postgres.
		const results = await this.d1.batch<{ id: string }>([
			this.d1.prepare(`UPDATE deploy_locks SET holder = holder
				WHERE lock_key = (SELECT app_id || ':' || env FROM runs WHERE id = ?)
					AND holder = ? AND expires_at > ?`).bind(id, guard.holder, guard.nowMs),
			this.d1.prepare(`${sql}
				AND ${checkpointPredicate}
				AND EXISTS (SELECT 1 FROM deploy_locks
					WHERE lock_key = runs.app_id || ':' || runs.env AND holder = ? AND expires_at > ?)
				RETURNING id`).bind(...values, ...checkpointValues, guard.holder, guard.nowMs),
		])
		return (results[1]?.results.length ?? 0) > 0
	}

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

	async getRunByExternalId(input: { appId: string; env: string; externalId: string }): Promise<RunRow | null> {
		const result = await this.d1.prepare(`SELECT * FROM runs
			WHERE app_id = ? AND env = ? AND external_run_id = ? LIMIT 2`)
			.bind(input.appId, input.env, input.externalId).all<RunRow>()
		if (result.results.length > 1) throw new Error('Provider version has ambiguous retained run state')
		return result.results[0] ?? null
	}

	/** Persist a provider-owned operation id and optional resume state in one guarded write. */
	async setRunExternalId(id: string, externalRunId: string, providerState?: JsonValue, guard?: RunMutationGuard): Promise<boolean> {
		const stateAssignment = providerState === undefined ? '' : ', provider_state_json = ?'
		const stateValues = providerState === undefined ? [] : [serializeProviderJson(providerState)]
		return this.mutateRun(
			id,
			`UPDATE runs SET external_run_id = ?${stateAssignment}
			WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
				AND (external_run_id IS NULL OR external_run_id = ?)`,
			[externalRunId, ...stateValues, id, externalRunId],
			guard,
		)
	}

	/** Reservation evidence survives a cancellation request so the current owner can settle cleanup. */
	async recordInitialRunExternalId(
		id: string,
		externalRunId: string,
		providerState: JsonValue | undefined,
		guard: RunMutationGuard,
	): Promise<boolean> {
		const stateAssignment = providerState === undefined ? '' : ', provider_state_json = ?'
		const stateValues = providerState === undefined ? [] : [serializeProviderJson(providerState)]
		return this.mutateRun(
			id,
			`UPDATE runs SET external_run_id = ?${stateAssignment}
			WHERE id = ? AND status = 'running' AND external_run_id IS NULL`,
			[externalRunId, ...stateValues, id],
			guard,
		)
	}

	/** Replace provider resume state only while the run remains active. */
	async checkpointRunProviderState(id: string, providerState: JsonValue, guard?: RunMutationGuard): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET provider_state_json = ?
			WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL AND external_run_id IS NOT NULL`,
			[serializeProviderJson(providerState), id],
			guard,
		)
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
	async markRunStarted(id: string, logKey: string, guard?: RunMutationGuard): Promise<boolean> {
		const runningPredicate = guard === undefined ? '' : `AND NOT EXISTS (SELECT 1 FROM runs active
			WHERE active.app_id = runs.app_id AND active.env = runs.env AND active.status = 'running' AND active.id <> runs.id)`
		return this.mutateRun(
			id,
			`UPDATE runs SET status = 'running', started_at = ?, log_key = ?
			WHERE id = ? AND status = 'pending' AND cancel_requested_at IS NULL ${runningPredicate}`,
			[this.now(), logKey, id],
			guard,
		)
	}

	/** Record one resolved commit while the active run still accepts provider lifecycle writes. */
	async setRunCommit(id: string, commitSha: string, guard?: RunMutationGuard): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET commit_sha = ?
			WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
				AND (commit_sha IS NULL OR LOWER(commit_sha) = ?)`,
			[commitSha, id, commitSha],
			guard,
		)
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
	async markRunFinished(id: string, status: 'succeeded' | 'failed', exitCode: number | null, guard?: RunMutationGuard): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET status = ?, exit_code = ?, finished_at = ?
			WHERE id = ? AND status IN ('pending','running') AND cancel_requested_at IS NULL`,
			[status, exitCode, this.now(), id],
			guard,
		)
	}

	/**
	 * The runner's `finishRun` records `succeeded` inside `startRun`, before control applies the IAM reconcile; this
	 * is the one succeeded→failed correction that a later failure needs. Keeps `finished_at`, refuses a cancelled run.
	 */
	async markRunFailedAfterRunner(id: string, guard?: RunMutationGuard): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET status = 'failed', exit_code = NULL
			WHERE id = ? AND status = 'succeeded' AND cancel_requested_at IS NULL`,
			[id],
			guard,
		)
	}

	/** Finish a run only after cancellation has durably claimed and completed provider cleanup. */
	async markRunCancellationFinished(id: string, guard?: RunMutationGuard): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET status = 'failed', exit_code = NULL, finished_at = ?
			WHERE id = ? AND status IN ('pending','running') AND cancel_requested_at IS NOT NULL`,
			[this.now(), id],
			guard,
		)
	}

	/** Candidates only: the lifecycle acquires their lease and rechecks age and state before settlement. */
	async listStaleRuns(maxAgeSeconds: number): Promise<RunRow[]> {
		const now = this.now()
		const result = await this.d1
			.prepare(`SELECT * FROM runs
				WHERE status IN ('pending','running')
					AND cancel_requested_at IS NULL
					AND COALESCE(started_at, created_at) < ?
					AND external_run_id IS NULL`)
			.bind(now - maxAgeSeconds)
			.all<RunRow>()
		return result.results
	}
}
