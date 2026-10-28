import type { SqlDatabase } from '@fabrika/platform'
import type { LeaseFence } from '../lease'

export type DevSandboxState = 'creating' | 'ready' | 'removing'

/**
 * The Box sandbox of one MCP workspace of a `dev` environment, and what its launcher follows and last reported: metadata
 * only, never a file's content. `log_json` and `checks_json` hold the launcher's own report, parsed again where read.
 */
export interface DevSandboxRow {
	workspace_id: string
	app_id: string
	env: string
	/** The Box sandbox id; null until Box created it. Stable for the workspace's life. */
	sandbox_id: string | null
	base_digest: string | null
	/** The Host Box routes the sandbox's ingress port by. */
	upstream_host: string | null
	state: DevSandboxState
	/** The vault reference of the workspace's sealed proxy secret. */
	proxy_secret_ref: string | null
	/** The run that last bootstrapped the sandbox. */
	bootstrap_run_id: string | null
	/** The run whose snapshot the workspace's proxy table follows. */
	published_run_id: string | null
	/** The head the sandbox should serve: the workspace's newest commit Control knows of. */
	target_sha: string | null
	/** The head the launcher last reported holding. */
	head_sha: string | null
	/** A head that needs a bootstrap run; Control sends no sync to it. */
	refused_sha: string | null
	/** The launcher's status (`DevStatus`), or `unbound` before its first report. */
	status: string
	message: string | null
	log_json: string
	checks_json: string | null
	reset_generation: number
	checks_generation: number
	/** The reset generation the launcher last reported applying. */
	reset_applied: number | null
	/** Unix seconds of the last bootstrap, commit or launcher request that keeps the sandbox awake. */
	activity_at: number
	reported_at: number | null
	/** Unix seconds when maintenance parked the sandbox; null while it runs. */
	parked_at: number | null
	/** Unix seconds of the last wake after an idle park. */
	woke_at: number | null
	/** Unix seconds of the launcher's last accepted wait or report. */
	launcher_seen_at: number | null
	/** Why Control cannot read the requests of the current launcher, in one line; null when it can. */
	launcher_refused: string | null
	created_at: number
}

export interface DevSandboxReadyInput {
	workspaceId: string
	sandboxId: string
	baseDigest: string
	upstreamHost: string
	proxySecretRef: string
}

export interface DevSandboxBootstrapInput {
	workspaceId: string
	runId: string
	targetSha: string
	now: number
}

export interface DevSandboxReportInput {
	head: string
	status: string
	/** The head the report refuses, or null. */
	refused: string | null
	message: string | null
	logJson: string
	/** The reset generation the launcher applied; null for a launcher with no record of one. */
	resetApplied: number | null
	/** The check results, when the report carries any. */
	checksJson: string | null
}

export class DevSandboxRepository {
	constructor(
		private readonly d1: SqlDatabase,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async get(workspaceId: string): Promise<DevSandboxRow | null> {
		return this.d1.prepare('SELECT * FROM dev_sandboxes WHERE workspace_id = ?').bind(workspaceId).first<DevSandboxRow>()
	}

	async listByEnvironment(appId: string, env: string): Promise<DevSandboxRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM dev_sandboxes WHERE app_id = ? AND env = ? ORDER BY workspace_id')
			.bind(appId, env)
			.all<DevSandboxRow>()
		return results
	}

	/**
	 * Record a sandbox about to be created; a row already there is returned unchanged. Null when the workspace does not
	 * exist or was abandoned: an abandoned workspace gets no sandbox, even from a bind that raced the abandon.
	 */
	async insertCreating(input: { workspaceId: string; appId: string; env: string; now: number }): Promise<DevSandboxRow | null> {
		await this.d1
			.prepare(`INSERT INTO dev_sandboxes (workspace_id, app_id, env, state, activity_at)
				SELECT ?, ?, ?, 'creating', ? WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND abandoned_at IS NULL)
				ON CONFLICT (workspace_id) DO NOTHING`)
			.bind(input.workspaceId, input.appId, input.env, input.now, input.workspaceId)
			.run()
		return this.d1
			.prepare(`SELECT dev_sandboxes.* FROM dev_sandboxes JOIN workspaces ON workspaces.id = dev_sandboxes.workspace_id
				WHERE dev_sandboxes.workspace_id = ? AND workspaces.abandoned_at IS NULL`)
			.bind(input.workspaceId)
			.first<DevSandboxRow>()
	}

	/**
	 * Box created, or returned, the sandbox: its id and host replace the recorded ones (a sandbox Box lost is created
	 * again). Null when the row is gone or being removed. A proxy secret the row records stays.
	 */
	async markReady(input: DevSandboxReadyInput): Promise<DevSandboxRow | null> {
		return this.d1
			.prepare(`UPDATE dev_sandboxes SET state = 'ready', sandbox_id = ?, base_digest = ?, upstream_host = ?,
					proxy_secret_ref = COALESCE(proxy_secret_ref, ?)
				WHERE workspace_id = ? AND state IN ('creating', 'ready') RETURNING *`)
			.bind(input.sandboxId, input.baseDigest, input.upstreamHost, input.proxySecretRef, input.workspaceId)
			.first<DevSandboxRow>()
	}

	/** The sandbox is being removed; returns the row so the caller knows which sandbox to delete. */
	async markRemoving(workspaceId: string): Promise<DevSandboxRow | null> {
		return this.d1
			.prepare(`UPDATE dev_sandboxes SET state = 'removing' WHERE workspace_id = ? RETURNING *`)
			.bind(workspaceId)
			.first<DevSandboxRow>()
	}

	/**
	 * Maintenance's mark: only while the sandbox is still removable, already `removing`, idle since `staleBefore`, or of
	 * an abandoned workspace. Null when a bind or commit made it active again meanwhile.
	 */
	async markRemovingIfRemovable(workspaceId: string, staleBefore: number): Promise<DevSandboxRow | null> {
		return this.d1
			.prepare(`UPDATE dev_sandboxes SET state = 'removing'
				WHERE workspace_id = ? AND (state = 'removing' OR activity_at < ?
					OR EXISTS (SELECT 1 FROM workspaces WHERE workspaces.id = dev_sandboxes.workspace_id AND workspaces.abandoned_at IS NOT NULL))
				RETURNING *`)
			.bind(workspaceId, staleBefore)
			.first<DevSandboxRow>()
	}

	/** Sandboxes an earlier removal left `removing`. */
	async listRemoving(): Promise<DevSandboxRow[]> {
		const { results } = await this.d1.prepare(`SELECT * FROM dev_sandboxes WHERE state = 'removing' ORDER BY workspace_id`).all<DevSandboxRow>()
		return results
	}

	/** Sandboxes whose workspace was abandoned: a bind that raced the abandon may have left one. */
	async listOfAbandonedWorkspaces(): Promise<DevSandboxRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT dev_sandboxes.* FROM dev_sandboxes JOIN workspaces ON workspaces.id = dev_sandboxes.workspace_id
				WHERE workspaces.abandoned_at IS NOT NULL ORDER BY dev_sandboxes.workspace_id`)
			.all<DevSandboxRow>()
		return results
	}

	async delete(workspaceId: string): Promise<boolean> {
		const result = await this.d1.prepare('DELETE FROM dev_sandboxes WHERE workspace_id = ?').bind(workspaceId).run()
		return result.meta.changes > 0
	}

	/**
	 * A bootstrap run rebuilds the sandbox from its own commit, so the record of what the previous build held, refused,
	 * logged or checked is cleared: its check results would read as the new build's.
	 */
	async startBootstrap(input: DevSandboxBootstrapInput): Promise<DevSandboxRow | null> {
		return this.d1
			.prepare(`UPDATE dev_sandboxes SET
					bootstrap_run_id = ?,
					target_sha = ?,
					refused_sha = NULL,
					status = 'unbound',
					message = NULL,
					launcher_refused = NULL,
					checks_json = NULL,
					log_json = '[]',
					activity_at = ?
				WHERE workspace_id = ? AND state <> 'removing' RETURNING *`)
			.bind(input.runId, input.targetSha, input.now, input.workspaceId)
			.first<DevSandboxRow>()
	}

	/** The run whose snapshot the workspace's proxy table now follows; a sandbox being removed follows none. */
	async recordPublishedRun(workspaceId: string, runId: string): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE dev_sandboxes SET published_run_id = ? WHERE workspace_id = ? AND state <> 'removing'`)
			.bind(runId, workspaceId)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * `recordPublishedRun` for the bootstrap run itself, fenced on its `<app>:<env>` lease: only a running run of the
	 * workspace's lane, whose holder still holds the lease, records itself.
	 */
	async recordPublishedRunUnderLease(workspaceId: string, runId: string, fence: LeaseFence): Promise<boolean> {
		const results = await this.d1.batch<{ workspace_id: string }>([
			this.d1.prepare(`UPDATE deploy_locks SET holder = holder
				WHERE lock_key = (SELECT app_id || ':' || env FROM runs WHERE id = ?)
					AND holder = ? AND expires_at > ?`).bind(runId, fence.holder, fence.nowMs),
			this.d1.prepare(`UPDATE dev_sandboxes SET published_run_id = ?
				WHERE workspace_id = ? AND state <> 'removing'
					AND EXISTS (SELECT 1 FROM runs
						WHERE runs.id = ? AND runs.app_id = dev_sandboxes.app_id AND runs.env = dev_sandboxes.env
							AND runs.lane = dev_sandboxes.workspace_id AND runs.status = 'running')
					AND EXISTS (SELECT 1 FROM deploy_locks
						WHERE lock_key = dev_sandboxes.app_id || ':' || dev_sandboxes.env AND holder = ? AND expires_at > ?)
				RETURNING workspace_id`).bind(runId, workspaceId, runId, fence.holder, fence.nowMs),
		])
		return (results.at(-1)?.results.length ?? 0) > 0
	}

	/** A new head of the workspace; returns the row, or null when it has no sandbox. */
	async advanceTarget(workspaceId: string, targetSha: string): Promise<DevSandboxRow | null> {
		return this.d1
			.prepare('UPDATE dev_sandboxes SET target_sha = ?, activity_at = ? WHERE workspace_id = ? RETURNING *')
			.bind(targetSha, this.now(), workspaceId)
			.first<DevSandboxRow>()
	}

	/** Ask the launcher to reset its schema: one past the generation it applied. */
	async advanceReset(workspaceId: string): Promise<DevSandboxRow | null> {
		return this.d1
			.prepare('UPDATE dev_sandboxes SET reset_generation = reset_generation + 1, activity_at = ? WHERE workspace_id = ? RETURNING *')
			.bind(this.now(), workspaceId)
			.first<DevSandboxRow>()
	}

	/** Ask the launcher to run the check chain; the results of the previous request are dropped. */
	async advanceChecks(workspaceId: string): Promise<DevSandboxRow | null> {
		return this.d1
			.prepare(`UPDATE dev_sandboxes SET checks_generation = checks_generation + 1, checks_json = NULL, activity_at = ?
				WHERE workspace_id = ? RETURNING *`)
			.bind(this.now(), workspaceId)
			.first<DevSandboxRow>()
	}

	/** Control itself refuses a head it cannot relay; the launcher keeps serving what it holds. */
	async recordRefusal(workspaceId: string, refusedSha: string, message: string): Promise<void> {
		await this.d1
			.prepare(`UPDATE dev_sandboxes SET refused_sha = ?, status = 'needs_bootstrap', message = ?, reported_at = ? WHERE workspace_id = ?`)
			.bind(refusedSha, message, this.now(), workspaceId)
			.run()
	}

	/** The launcher's wait was accepted: it talks to Control, so nothing refuses it and the sandbox is awake. */
	async recordLauncherSeen(workspaceId: string): Promise<void> {
		await this.d1
			.prepare('UPDATE dev_sandboxes SET launcher_seen_at = ?, launcher_refused = NULL, parked_at = NULL WHERE workspace_id = ?')
			.bind(this.now(), workspaceId)
			.run()
	}

	/**
	 * Control could not read a request of the launcher. Recorded only while no request was accepted since `since`, when
	 * the current launcher started: once it talks, a refused request comes from a launcher it replaced.
	 */
	async recordLauncherRefused(workspaceId: string, reason: string, since: number): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE dev_sandboxes SET launcher_refused = ?
				WHERE workspace_id = ? AND (launcher_seen_at IS NULL OR launcher_seen_at < ?)`)
			.bind(reason, workspaceId, since)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * What the launcher reported. A report holding the refused head clears the refusal: a bootstrap run built it. Results
	 * of checks are replaced only by a report that carries some. A launcher that reports runs, so the sandbox is awake.
	 */
	async recordReport(workspaceId: string, report: DevSandboxReportInput): Promise<DevSandboxRow | null> {
		const now = this.now()
		return this.d1
			.prepare(`UPDATE dev_sandboxes SET
					head_sha = ?,
					status = ?,
					message = ?,
					log_json = ?,
					checks_json = COALESCE(?, checks_json),
					reset_applied = ?,
					refused_sha = CASE WHEN CAST(? AS TEXT) IS NOT NULL THEN CAST(? AS TEXT) WHEN refused_sha = ? THEN NULL ELSE refused_sha END,
					reported_at = ?,
					activity_at = ?,
					launcher_seen_at = ?,
					launcher_refused = NULL,
					parked_at = NULL
				WHERE workspace_id = ? RETURNING *`)
			.bind(
				report.head,
				report.status,
				report.message,
				report.logJson,
				report.checksJson,
				report.resetApplied,
				report.refused,
				report.refused,
				report.head,
				now,
				now,
				now,
				workspaceId,
			)
			.first<DevSandboxRow>()
	}

	/** Ready sandboxes that run and saw no activity since `before`. */
	async listIdle(before: number): Promise<DevSandboxRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT * FROM dev_sandboxes WHERE state = 'ready' AND parked_at IS NULL AND activity_at < ? ORDER BY workspace_id`)
			.bind(before)
			.all<DevSandboxRow>()
		return results
	}

	/** Sandboxes, in any state, whose workspace saw no activity since `before`: maintenance removes them. */
	async listStale(before: number): Promise<DevSandboxRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM dev_sandboxes WHERE activity_at < ? ORDER BY workspace_id')
			.bind(before)
			.all<DevSandboxRow>()
		return results
	}

	/** Recorded only while the sandbox stayed idle since `before`: a request that arrived meanwhile wins. */
	async markParked(workspaceId: string, before: number): Promise<boolean> {
		const result = await this.d1
			.prepare('UPDATE dev_sandboxes SET parked_at = ? WHERE workspace_id = ? AND parked_at IS NULL AND activity_at < ?')
			.bind(this.now(), workspaceId, before)
			.run()
		return result.meta.changes > 0
	}

	/** Parking the sandbox failed, so it still runs; its idle time stays as it was, so the next pass retries. */
	async clearParked(workspaceId: string): Promise<void> {
		await this.d1.prepare('UPDATE dev_sandboxes SET parked_at = NULL WHERE workspace_id = ?').bind(workspaceId).run()
	}

	/** The sandbox was woken; returns whether it was recorded as parked. */
	async markWoke(workspaceId: string): Promise<boolean> {
		const now = this.now()
		const result = await this.d1
			.prepare(`UPDATE dev_sandboxes SET parked_at = NULL, activity_at = ?, woke_at = ?
				WHERE workspace_id = ? AND parked_at IS NOT NULL`)
			.bind(now, now, workspaceId)
			.run()
		return result.meta.changes > 0
	}
}
