import type { SqlDatabase } from '@fabrika/platform'
import { type AppEnvRow, type AppRow } from './registry-types'
import { firstRow } from './returning'

/**
 * Per-(app, env) public-repo poll bookkeeping (migrations/0001_init.sql). One row per pollable
 * (app, env): the feed's last ETag (for the conditional GET), the head sha the poller last enqueued
 * for, the last poll time, and a short last-error string. Only public apps (no GitHub App install)
 * with a `trigger_ref` are polled — see `getPollEligibleEnvs`.
 */
export interface RepoPollStateRow {
	app_id: string
	env: string
	etag: string | null
	last_seen_sha: string | null
	last_polled_at: number | null
	last_error: string | null
}

// ── Repo polling (public repos: no GitHub App install → pulled, not pushed) ───

export class RepoPollingRepository {
	constructor(protected readonly d1: SqlDatabase) {}

	/**
	 * The (app, env) pairs eligible for poll-based triggering: a PUBLIC app (no GitHub App install, so
	 * no webhook delivery) that has a subscribed ref. Private apps keep using the webhook; manual-only
	 * envs (null trigger_ref) are never polled. Joins apps + app_envs so the poller has both rows.
	 */
	async getPollEligibleEnvs(): Promise<Array<{ app: AppRow; appEnv: AppEnvRow }>> {
		const { results } = await this.d1
			.prepare(`SELECT
					a.id AS a_id, a.repo_url AS a_repo_url, a.default_branch AS a_default_branch, a.worker_dir AS a_worker_dir,
					a.build_cmd AS a_build_cmd, a.config_path AS a_config_path,
					a.github_connection_id AS a_github_connection_id, a.github_installation_id AS a_github_installation_id,
					a.created_at AS a_created_at,
						e.app_id AS e_app_id, e.env AS e_env, e.domain AS e_domain, e.public_origin AS e_public_origin,
						e.trigger_ref AS e_trigger_ref,
						e.namespace_id AS e_namespace_id,
						e.provider AS e_provider, e.provider_target_json AS e_provider_target_json,
						e.provider_artifact_json AS e_provider_artifact_json,
						e.created_at AS e_created_at
				FROM apps a
				JOIN app_envs e ON e.app_id = a.id
				WHERE a.github_installation_id IS NULL AND e.trigger_ref IS NOT NULL
				ORDER BY a.id, e.env`)
			.all<PollEligibleJoinRow>()
		return results.map((r) => ({
			app: {
				id: r.a_id,
				repo_url: r.a_repo_url,
				default_branch: r.a_default_branch,
				worker_dir: r.a_worker_dir,
				build_cmd: r.a_build_cmd,
				config_path: r.a_config_path,
				github_connection_id: r.a_github_connection_id,
				github_installation_id: r.a_github_installation_id,
				created_at: r.a_created_at,
			},
			appEnv: {
				app_id: r.e_app_id,
				env: r.e_env,
				domain: r.e_domain,
				public_origin: r.e_public_origin,
				trigger_ref: r.e_trigger_ref,
				namespace_id: r.e_namespace_id,
				provider: r.e_provider,
				provider_target_json: r.e_provider_target_json,
				provider_artifact_json: r.e_provider_artifact_json,
				created_at: r.e_created_at,
			},
		}))
	}

	async getRepoPollState(appId: string, env: string): Promise<RepoPollStateRow | null> {
		return this.d1.prepare('SELECT * FROM repo_poll_state WHERE app_id = ? AND env = ?').bind(appId, env).first<RepoPollStateRow>()
	}

	/** Upsert the poll state for an (app, env). ON CONFLICT (app_id, env) overwrites the mutable columns. */
	async upsertRepoPollState(input: {
		appId: string
		env: string
		etag?: string | null
		lastSeenSha?: string | null
		lastPolledAt: number
		lastError?: string | null
	}): Promise<RepoPollStateRow> {
		return firstRow<RepoPollStateRow>(
			this.d1
				.prepare(`INSERT INTO repo_poll_state (app_id, env, etag, last_seen_sha, last_polled_at, last_error)
					VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT (app_id, env) DO UPDATE SET
						etag = excluded.etag,
						last_seen_sha = excluded.last_seen_sha,
						last_polled_at = excluded.last_polled_at,
						last_error = excluded.last_error
					RETURNING *`)
				.bind(
					input.appId,
					input.env,
					input.etag ?? null,
					input.lastSeenSha ?? null,
					input.lastPolledAt,
					input.lastError ?? null,
				),
		)
	}
}

/** The flattened, prefixed shape of the apps⋈app_envs join in `getPollEligibleEnvs` (no `as` casts). */
interface PollEligibleJoinRow {
	a_id: string
	a_repo_url: string
	a_default_branch: string
	a_worker_dir: string | null
	a_build_cmd: string | null
	a_config_path: string | null
	a_github_connection_id: string | null
	a_github_installation_id: number | null
	a_created_at: number
	e_app_id: string
	e_env: string
	e_domain: string | null
	e_public_origin: string | null
	e_trigger_ref: string | null
	e_namespace_id: string | null
	e_provider: string
	e_provider_target_json: string
	e_provider_artifact_json: string
	e_created_at: number
}
