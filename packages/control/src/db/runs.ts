import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import type { LeaseFence } from '../lease'
import { runCoordinateLockStatements } from './coordinate-lock'
import { firstRow } from './returning'

export type RunTrigger = 'webhook' | 'manual' | 'poll'

/** `awaiting_approval`: a widening on a protected environment parked the run until a human decides (ADR-0050). */
export type RunStatus = 'pending' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed'

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
	/** Who created the run: `user:<id>`, `service:<id>`, `oauth:<id>`, `webhook:<connection>` or `poll`; NULL before actors. */
	actor: string | null
	/** The access snapshot read at the pinned commit (`src/approval/snapshot.ts`). */
	snapshot_json: string | null
	/** The diff against the active snapshot the run was last compared with (`src/approval/diff.ts`). */
	classification_json: string | null
	/** The human approval of the classified change, bound to both digests. */
	approval_json: string | null
	// `pending_access_json` is no longer read or written; the column stays until a later migration release drops it.
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

	/** Every lifecycle write is holder-fenced on the run's `<app>:<env>` lease. */
	/** `after` runs in the same batch, so it sees the run's update and the still-locked lease row. */
	private async mutateRun(
		id: string,
		sql: string,
		values: (string | number | null)[],
		fence: LeaseFence,
		after: readonly SqlStatement[] = [],
	): Promise<boolean> {
		// The lease row must stay locked through the mutation: an EXISTS alone races takeover on Postgres.
		const results = await this.d1.batch<{ id: string }>([
			this.d1.prepare(`UPDATE deploy_locks SET holder = holder
				WHERE lock_key = (SELECT app_id || ':' || env FROM runs WHERE id = ?)
					AND holder = ? AND expires_at > ?`).bind(id, fence.holder, fence.nowMs),
			this.d1.prepare(`${sql}
				AND EXISTS (SELECT 1 FROM deploy_locks
					WHERE lock_key = runs.app_id || ':' || runs.env AND holder = ? AND expires_at > ?)
				RETURNING id`).bind(...values, fence.holder, fence.nowMs),
			...after,
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
		actor: string
	}): Promise<RunRow> {
		return firstRow<RunRow>(
			this.d1
				.prepare(`INSERT INTO runs (id, app_id, env, ref, commit_sha, trigger, status, actor)
					VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING *`)
				.bind(input.id, input.appId, input.env, input.ref, input.commitSha ?? null, input.trigger, input.actor),
		)
	}

	/** The newest run that deployed one ref to one environment. */
	async getLatestRunForRef(input: { appId: string; env: string; ref: string }): Promise<RunRow | null> {
		return this.d1.prepare(`SELECT * FROM runs WHERE app_id = ? AND env = ? AND ref = ?
			ORDER BY id DESC LIMIT 1`).bind(input.appId, input.env, input.ref).first<RunRow>()
	}

	/** The run that last finished successfully in one environment: what it runs now. */
	async getLatestSucceededRun(input: { appId: string; env: string }): Promise<RunRow | null> {
		return this.d1.prepare(`SELECT * FROM runs WHERE app_id = ? AND env = ? AND status = 'succeeded'
			ORDER BY finished_at DESC, id DESC LIMIT 1`).bind(input.appId, input.env).first<RunRow>()
	}

	async getRun(id: string): Promise<RunRow | null> {
		return this.d1.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>()
	}

	/** Reservation evidence survives a cancellation request so the current owner can settle cleanup. */
	async recordInitialRunExternalId(
		id: string,
		externalRunId: string,
		providerState: JsonValue | undefined,
		fence: LeaseFence,
	): Promise<boolean> {
		const stateAssignment = providerState === undefined ? '' : ', provider_state_json = ?'
		const stateValues = providerState === undefined ? [] : [serializeProviderJson(providerState)]
		return this.mutateRun(
			id,
			`UPDATE runs SET external_run_id = ?${stateAssignment}
			WHERE id = ? AND status = 'running' AND external_run_id IS NULL`,
			[externalRunId, ...stateValues, id],
			fence,
		)
	}

	/** Replace provider resume state only while the run remains active. */
	async checkpointRunProviderState(id: string, providerState: JsonValue, fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET provider_state_json = ?
			WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL AND external_run_id IS NOT NULL`,
			[serializeProviderJson(providerState), id],
			fence,
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
	 * §6.2 monotonic counter (`@fabrika/platform`), so a TEXT `ORDER BY id DESC` is chronological down to the
	 * individual mint — two runs created in the SAME millisecond still order by which was created
	 * first. That is what makes `before` a sound keyset cursor: no page can skip or repeat a row.
	 */
	async listRuns(filter: { appId?: string; env?: string; statuses?: RunStatus[]; before?: string; limit: number }): Promise<RunRow[]> {
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
		if (filter.statuses !== undefined) {
			if (filter.statuses.length === 0) return []
			where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
			binds.push(...filter.statuses)
		}
		const sql = `SELECT * FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
		binds.push(filter.limit)
		const { results } = await this.d1.prepare(sql).bind(...binds).all<RunRow>()
		return results
	}

	/**
	 * Per registered app environment, its newest finished run when that run failed, newest first. A later finished run
	 * supersedes a failure; a run still in flight does not. A deleted environment has nothing left to fix.
	 */
	async listLatestFailedRuns(): Promise<RunRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT r.* FROM runs r
				JOIN app_envs e ON e.app_id = r.app_id AND e.env = r.env
				WHERE r.status = 'failed'
					AND NOT EXISTS (SELECT 1 FROM runs later
						WHERE later.app_id = r.app_id AND later.env = r.env AND later.id > r.id
							AND later.status IN ('succeeded', 'failed'))
				ORDER BY r.id DESC`)
			.all<RunRow>()
		return results
	}

	/**
	 * Move a run `pending → running`: stamp `started_at` and the R2 log key. Guarded on the current
	 * status so a redelivered queue message can't re-start a run already past pending, and refused while
	 * another run of the environment runs or once a newer one succeeded (`markRunSuperseded`). Returns true
	 * iff the row transitioned.
	 */
	async markRunStarted(id: string, logKey: string, fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET status = 'running', started_at = ?, log_key = ?
			WHERE id = ? AND status = 'pending' AND cancel_requested_at IS NULL
				AND NOT EXISTS (SELECT 1 FROM runs active
					WHERE active.app_id = runs.app_id AND active.env = runs.env AND active.status = 'running' AND active.id <> runs.id)
				AND NOT EXISTS (SELECT 1 FROM runs newer
					WHERE newer.app_id = runs.app_id AND newer.env = runs.env AND newer.id > runs.id AND newer.status = 'succeeded')`,
			[this.now(), logKey, id],
			fence,
		)
	}

	/** The newest run of the same environment, created after this one, that succeeded: the run that supersedes it. */
	async getSupersedingRun(id: string): Promise<RunRow | null> {
		return this.d1.prepare(`SELECT newer.* FROM runs newer
			JOIN runs older ON older.app_id = newer.app_id AND older.env = newer.env
			WHERE older.id = ? AND newer.id > older.id AND newer.status = 'succeeded'
			ORDER BY newer.id DESC LIMIT 1`).bind(id).first<RunRow>()
	}

	/**
	 * Fail a pending run that a newer succeeded run of its environment supersedes, before it starts: an older run never
	 * deploys over a newer success, and a rollback is a new run (ADR-0050 §6).
	 */
	async markRunSuperseded(id: string, fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET status = 'failed', finished_at = ?
			WHERE id = ? AND status = 'pending' AND cancel_requested_at IS NULL
				AND EXISTS (SELECT 1 FROM runs newer
					WHERE newer.app_id = runs.app_id AND newer.env = runs.env AND newer.id > runs.id AND newer.status = 'succeeded')`,
			[this.now(), id],
			fence,
		)
	}

	/** Record one resolved commit while the active run still accepts provider lifecycle writes. */
	async setRunCommit(id: string, commitSha: string, fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET commit_sha = ?
			WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
				AND (commit_sha IS NULL OR LOWER(commit_sha) = ?)`,
			[commitSha, id, commitSha],
			fence,
		)
	}

	/** Record the access snapshot read at the run's pinned commit. */
	async recordRunSnapshot(id: string, snapshotJson: string, fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET snapshot_json = ?
			WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL`,
			[snapshotJson, id],
			fence,
		)
	}

	/** Record the classification a run publishes with. */
	async recordRunClassification(id: string, classificationJson: string, fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET classification_json = ?
			WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL`,
			[classificationJson, id],
			fence,
		)
	}

	/**
	 * Park a running run whose widening waits for a human (ADR-0050), with the classification the approver reads. An
	 * approval the run held stays: it names the digests it approved, so it approves nothing this classification shows,
	 * and the approval page says it lapsed.
	 */
	async parkRunForApproval(id: string, classificationJson: string, fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET status = 'awaiting_approval', classification_json = ?
			WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL`,
			[classificationJson, id],
			fence,
		)
	}

	/**
	 * Record a human approval of a parked run and queue it again, only while it still shows the classification the
	 * approver read. Executed under the run's lease, like every lifecycle write.
	 */
	async approveParkedRun(id: string, classificationJson: string, approvalJson: string, fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET status = 'pending', approval_json = ?
			WHERE id = ? AND status = 'awaiting_approval' AND cancel_requested_at IS NULL AND classification_json = ?`,
			[approvalJson, id, classificationJson],
			fence,
		)
	}

	/** Refuse a parked run: it fails without touching the provider. */
	async rejectParkedRun(id: string, classificationJson: string, fence: LeaseFence): Promise<boolean> {
		// A refusal decides the run: an approval that lapsed before it approved nothing this run ran with.
		return this.mutateRun(
			id,
			`UPDATE runs SET status = 'failed', finished_at = ?, approval_json = NULL
			WHERE id = ? AND status = 'awaiting_approval' AND cancel_requested_at IS NULL AND classification_json = ?`,
			[this.now(), id, classificationJson],
			fence,
		)
	}

	/** Runs parked for approval, newest first. */
	async listRunsAwaitingApproval(limit: number): Promise<RunRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT * FROM runs WHERE status = 'awaiting_approval' ORDER BY id DESC LIMIT ?`)
			.bind(limit)
			.all<RunRow>()
		return results
	}

	/**
	 * Publish `snapshotJson` as the run's environment's active access (ADR-0050): a compare-and-swap on the generation and
	 * the protection revision the run classified against, fenced on the run's lease. False when another publication, a
	 * registry write or a protection change won.
	 */
	async publishRunSnapshot(
		id: string,
		expected: { readonly generation: number; readonly protectionRevision: number },
		snapshotJson: string,
		fence: LeaseFence,
	): Promise<boolean> {
		const results = await this.d1.batch<{ app_id: string }>([
			this.d1.prepare(`UPDATE deploy_locks SET holder = holder
				WHERE lock_key = (SELECT app_id || ':' || env FROM runs WHERE id = ?)
					AND holder = ? AND expires_at > ?`).bind(id, fence.holder, fence.nowMs),
			...runCoordinateLockStatements(this.d1, id),
			this.d1.prepare(`UPDATE app_envs SET published_run_id = ?, published_snapshot_json = ?, generation = generation + 1
				WHERE generation = ? AND protection_revision = ?
					AND EXISTS (SELECT 1 FROM runs
						WHERE runs.id = ? AND runs.app_id = app_envs.app_id AND runs.env = app_envs.env
							AND runs.status = 'running' AND runs.cancel_requested_at IS NULL AND runs.snapshot_json IS NOT NULL)
					AND EXISTS (SELECT 1 FROM deploy_locks
						WHERE lock_key = app_envs.app_id || ':' || app_envs.env AND holder = ? AND expires_at > ?)
				RETURNING app_id`).bind(id, snapshotJson, expected.generation, expected.protectionRevision, id, fence.holder, fence.nowMs),
		])
		return (results.at(-1)?.results.length ?? 0) > 0
	}

	/**
	 * Record a cancellation REQUEST and return the latest active run snapshot. The one unfenced run update:
	 * it changes no lifecycle state, and the lease holder reads it at its next step boundary.
	 */
	async requestRunCancellation(id: string): Promise<RunRow | null> {
		return this.d1
			.prepare(`UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?)
				WHERE id = ? AND status IN ('pending','running','awaiting_approval') RETURNING *`)
			.bind(this.now(), id)
			.first<RunRow>()
	}

	/**
	 * Move a run to a terminal state (`succeeded` | `failed`): stamp `finished_at` + the exit code.
	 * Returns true iff the row transitioned (it was still `running`/`pending`).
	 */
	async markRunFinished(id: string, status: 'succeeded' | 'failed', exitCode: number | null, fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET status = ?, exit_code = ?, finished_at = ?
			WHERE id = ? AND status IN ('pending','running') AND cancel_requested_at IS NULL`,
			[status, exitCode, this.now(), id],
			fence,
		)
	}

	/**
	 * Finish a run only after cancellation has durably claimed and settled provider work; activation may have won first.
	 * A run cancelled while it waited for approval drops the approval it held: that one lapsed, it approved nothing.
	 */
	async markRunCancellationFinished(id: string, status: 'succeeded' | 'failed', fence: LeaseFence): Promise<boolean> {
		return this.mutateRun(
			id,
			`UPDATE runs SET status = ?, exit_code = NULL, finished_at = ?,
				approval_json = CASE WHEN status = 'awaiting_approval' THEN NULL ELSE approval_json END
			WHERE id = ? AND status IN ('pending','running','awaiting_approval') AND cancel_requested_at IS NOT NULL`,
			[status, this.now(), id],
			fence,
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
