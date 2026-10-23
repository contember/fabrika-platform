import type { SqlDatabase } from '@fabrika/platform'
import { firstRow } from './returning'

/**
 * What a `dev` environment follows and what its launcher last reported (ADR-0049): metadata only, never a file's
 * content. `log_json` and `checks_json` hold the launcher's own report, parsed again where they are read.
 */
export interface DevEnvironmentRow {
	app_id: string
	env: string
	/** The workspace bound to it; null before `bind_dev`. */
	workspace_id: string | null
	/** The run that built the container the launcher runs in. */
	bootstrap_run_id: string | null
	/** The head the environment should serve: the bound workspace's newest commit Control knows of. */
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
	/** Unix seconds of the last bind, commit or launcher request that keeps the environment awake. */
	activity_at: number
	reported_at: number | null
	/** Unix seconds when maintenance stopped its service; null while it runs. */
	stopped_at: number | null
	created_at: number
	/** Unix seconds of the launcher's last accepted wait or report. */
	launcher_seen_at: number | null
	/** Why Control cannot read the requests of the current container, in one line; null when it can. */
	launcher_refused: string | null
	/** Unix seconds of the last start after an idle stop, which boots the container again. */
	service_started_at: number | null
}

export interface DevBindInput {
	appId: string
	env: string
	workspaceId: string
	targetSha: string
	/** The bootstrap run, or null when the bound container is reused. */
	bootstrapRunId: string | null
	/** A switch to another workspace resets the schema, so no migration of the previous one stays applied. */
	reset: boolean
}

export interface DevReportInput {
	head: string
	status: string
	/** The head the report refuses, or null. */
	refused: string | null
	message: string | null
	logJson: string
	/** The reset generation the launcher applied; null for a container with no record of one. */
	resetApplied: number | null
	/** The check results, when the report carries any. */
	checksJson: string | null
}

export class DevEnvironmentRepository {
	constructor(
		private readonly d1: SqlDatabase,
		private readonly now: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async get(appId: string, env: string): Promise<DevEnvironmentRow | null> {
		return this.d1.prepare('SELECT * FROM dev_environments WHERE app_id = ? AND env = ?').bind(appId, env).first<DevEnvironmentRow>()
	}

	/** The environment the workspace is bound to, if any: an application has one. */
	async getByWorkspace(workspaceId: string): Promise<DevEnvironmentRow | null> {
		return this.d1.prepare('SELECT * FROM dev_environments WHERE workspace_id = ?').bind(workspaceId).first<DevEnvironmentRow>()
	}

	/**
	 * Bind a workspace. A bootstrap run starts a container from its own commit, so the record of what the previous one
	 * held, refused, logged or checked is cleared: its check results would read as the new container's.
	 */
	async bind(input: DevBindInput): Promise<DevEnvironmentRow> {
		const now = this.now()
		const fresh = input.bootstrapRunId !== null
		return firstRow<DevEnvironmentRow>(
			this.d1
				.prepare(`INSERT INTO dev_environments (app_id, env, workspace_id, bootstrap_run_id, target_sha, activity_at)
					VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT (app_id, env) DO UPDATE SET
						workspace_id = excluded.workspace_id,
						bootstrap_run_id = COALESCE(excluded.bootstrap_run_id, dev_environments.bootstrap_run_id),
						target_sha = excluded.target_sha,
						refused_sha = CASE WHEN ? = 1 THEN NULL ELSE dev_environments.refused_sha END,
						status = CASE WHEN ? = 1 THEN 'unbound' ELSE dev_environments.status END,
						message = CASE WHEN ? = 1 THEN NULL ELSE dev_environments.message END,
						launcher_refused = CASE WHEN ? = 1 THEN NULL ELSE dev_environments.launcher_refused END,
						checks_json = CASE WHEN ? = 1 THEN NULL ELSE dev_environments.checks_json END,
						log_json = CASE WHEN ? = 1 THEN '[]' ELSE dev_environments.log_json END,
						reset_generation = dev_environments.reset_generation + ?,
						activity_at = excluded.activity_at
					RETURNING *`)
				.bind(
					input.appId,
					input.env,
					input.workspaceId,
					input.bootstrapRunId,
					input.targetSha,
					now,
					fresh ? 1 : 0,
					fresh ? 1 : 0,
					fresh ? 1 : 0,
					fresh ? 1 : 0,
					fresh ? 1 : 0,
					fresh ? 1 : 0,
					input.reset ? 1 : 0,
				),
		)
	}

	/** A new head of the bound workspace; returns the row, or null when the workspace is no longer bound. */
	async advanceTarget(appId: string, env: string, workspaceId: string, targetSha: string): Promise<DevEnvironmentRow | null> {
		return this.d1
			.prepare(`UPDATE dev_environments SET target_sha = ?, activity_at = ? WHERE app_id = ? AND env = ? AND workspace_id = ? RETURNING *`)
			.bind(targetSha, this.now(), appId, env, workspaceId)
			.first<DevEnvironmentRow>()
	}

	/** Ask the launcher to reset its schema: one past the generation it applied. */
	async advanceReset(appId: string, env: string): Promise<DevEnvironmentRow | null> {
		return this.d1
			.prepare('UPDATE dev_environments SET reset_generation = reset_generation + 1, activity_at = ? WHERE app_id = ? AND env = ? RETURNING *')
			.bind(this.now(), appId, env)
			.first<DevEnvironmentRow>()
	}

	/** Ask the launcher to run the check chain; the results of the previous request are dropped. */
	async advanceChecks(appId: string, env: string): Promise<DevEnvironmentRow | null> {
		return this.d1
			.prepare(`UPDATE dev_environments SET checks_generation = checks_generation + 1, checks_json = NULL, activity_at = ?
				WHERE app_id = ? AND env = ? RETURNING *`)
			.bind(this.now(), appId, env)
			.first<DevEnvironmentRow>()
	}

	/** Control itself refuses a head it cannot relay; the launcher keeps serving what it holds. */
	async recordRefusal(appId: string, env: string, refusedSha: string, message: string): Promise<void> {
		await this.d1
			.prepare(`UPDATE dev_environments SET refused_sha = ?, status = 'needs_bootstrap', message = ?, reported_at = ? WHERE app_id = ? AND env = ?`)
			.bind(refusedSha, message, this.now(), appId, env)
			.run()
	}

	/** The launcher's wait was accepted: it talks to Control, so nothing refuses it. */
	async recordLauncherSeen(appId: string, env: string): Promise<void> {
		await this.d1
			.prepare('UPDATE dev_environments SET launcher_seen_at = ?, launcher_refused = NULL WHERE app_id = ? AND env = ?')
			.bind(this.now(), appId, env)
			.run()
	}

	/**
	 * Control could not read a request of the launcher. Recorded only while no request was accepted since `since`, when
	 * the current container booted: once it talks, a refused request comes from a container it replaced.
	 */
	async recordLauncherRefused(appId: string, env: string, reason: string, since: number): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE dev_environments SET launcher_refused = ?
				WHERE app_id = ? AND env = ? AND (launcher_seen_at IS NULL OR launcher_seen_at < ?)`)
			.bind(reason, appId, env, since)
			.run()
		return result.meta.changes > 0
	}

	/**
	 * What the launcher reported. A report holding the refused head clears the refusal: a bootstrap run built it. Results
	 * of checks are replaced only by a report that carries some.
	 */
	async recordReport(appId: string, env: string, report: DevReportInput): Promise<DevEnvironmentRow | null> {
		const now = this.now()
		return this.d1
			.prepare(`UPDATE dev_environments SET
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
					launcher_refused = NULL
				WHERE app_id = ? AND env = ? RETURNING *`)
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
				appId,
				env,
			)
			.first<DevEnvironmentRow>()
	}

	/** Bound environments whose service runs and that saw no activity since `before`. */
	async listIdle(before: number): Promise<DevEnvironmentRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM dev_environments WHERE workspace_id IS NOT NULL AND stopped_at IS NULL AND activity_at < ? ORDER BY app_id, env')
			.bind(before)
			.all<DevEnvironmentRow>()
		return results
	}

	/** Recorded only while the environment stayed idle since `before`: a request that arrived meanwhile wins. */
	async markStopped(appId: string, env: string, before: number): Promise<boolean> {
		const result = await this.d1
			.prepare('UPDATE dev_environments SET stopped_at = ? WHERE app_id = ? AND env = ? AND stopped_at IS NULL AND activity_at < ?')
			.bind(this.now(), appId, env, before)
			.run()
		return result.meta.changes > 0
	}

	/** Stopping the service failed, so it still runs; its idle time stays as it was, so the next pass retries. */
	async clearStopped(appId: string, env: string): Promise<void> {
		await this.d1.prepare('UPDATE dev_environments SET stopped_at = NULL WHERE app_id = ? AND env = ?').bind(appId, env).run()
	}

	/** The service was started again; returns whether it was recorded as stopped. */
	async markStarted(appId: string, env: string): Promise<boolean> {
		const result = await this.d1
			.prepare(`UPDATE dev_environments SET stopped_at = NULL, activity_at = ?, service_started_at = ?
				WHERE app_id = ? AND env = ? AND stopped_at IS NOT NULL`)
			.bind(this.now(), this.now(), appId, env)
			.run()
		return result.meta.changes > 0
	}
}
