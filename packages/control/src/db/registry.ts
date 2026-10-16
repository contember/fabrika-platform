import { type DeployLocks, type SqlDatabase, SqlDeployLocks, type SqlStatement } from '@fabrika/platform'
import type { ProviderSourceBinding } from '@fabrika/provider-contract'
import { type LeaseFence, namespaceLeaseKey, runLeaseKey } from '../lease'
import { appCoordinateLockStatements, appRowLockStatement, coordinateLockStatements, defaultProtected } from './coordinate-lock'
import {
	AppEnvChangedError,
	type AppEnvExpectation,
	type AppEnvInput,
	type AppEnvRow,
	AppEnvTriggerRefConflictError,
	type AppInput,
	type AppRow,
	type AppSecretRow,
	type AppVarRow,
	type DeploymentNamespaceInput,
	type DeploymentNamespaceRow,
	type DeploymentNamespaceState,
	NamespaceResourceClaimConflictError,
	type NamespaceResourceClaimOwner,
	type NamespaceResourceClaimRow,
	SourceBindingError,
} from './registry-types'
import { firstRow } from './returning'

/**
 * The mark an in-flight or unconfirmed `namespaces.update` leaves on a row: the target it was moving to.
 * The update writes it together with state `failed` and a `namespaceUpdateUnconfirmed` error.
 */
export function isUnconfirmedNamespaceUpdate(row: Pick<DeploymentNamespaceRow, 'update_target_json'>): boolean {
	return row.update_target_json !== null
}

/** Portable registry persistence; a composition root may replace this complete capability. */
/**
 * A new environment starts from what a deleted one of the same coordinates left: its `protected` flag (else the
 * default, `prod` protected) and its counters (ADR-0050).
 */
const APP_ENV_INSERT_SQL = `INSERT INTO app_envs (
		app_id, env, domain, public_origin, trigger_ref, namespace_id, provider,
		provider_target_json, provider_artifact_json, authoring, protected, generation, protection_revision
	)
	SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0),
		COALESCE(kept.protected, ?), COALESCE(kept.generation, 0), COALESCE(kept.protection_revision, 0)
	FROM (SELECT 1 AS one) AS fresh
	LEFT JOIN app_env_protection AS kept ON kept.app_id = ? AND kept.env = ?
	WHERE true`

const appEnvInsertValues = (input: AppEnvInput): (string | number | null)[] => [
	input.appId,
	input.env,
	input.domain ?? null,
	input.publicOrigin ?? null,
	input.triggerRef ?? null,
	input.namespaceId,
	input.provider,
	input.providerTargetJson,
	input.providerArtifactJson,
	authoringFlag(input.authoring),
	defaultProtected(input.env),
	input.appId,
	input.env,
]

/**
 * Keep a deleted environment's `protected` flag and counters, `generation` advanced past every value a run could have
 * read: a run that classified against it then loses its compare-and-swap against a recreated one.
 */
const appEnvTombstoneSql = `INSERT INTO app_env_protection (app_id, env, protected, generation, protection_revision)
	SELECT app_id, env, protected, generation + 1, protection_revision FROM app_envs`

const APP_ENV_TOMBSTONE_CONFLICT = `ON CONFLICT (app_id, env) DO UPDATE SET
	protected = excluded.protected, generation = excluded.generation, protection_revision = excluded.protection_revision`

const claimRows = (
	results: readonly { readonly results: readonly (AppRow | AppEnvRow | NamespaceResourceClaimRow)[] }[],
): NamespaceResourceClaimRow[] =>
	results.map((result) => {
		const [claim] = result.results
		if (claim === undefined || !('resource_key' in claim) || result.results.length !== 1) {
			throw new Error('expected one row from a namespace resource claim acquisition')
		}
		return claim
	})

export class ControlRegistryRepository {
	/**
	 * `now` is injectable so caller-stamped timestamps are deterministic in tests (same approach as
	 * `SqlDeployLocks`); production passes the real clock. It returns unix SECONDS — the unit every
	 * `*_at` column in this schema uses.
	 */
	constructor(protected readonly d1: SqlDatabase, protected readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	// ── Apps ────────────────────────────────────────────────────────────────────

	async listApps(): Promise<AppRow[]> {
		const { results } = await this.d1.prepare('SELECT * FROM apps ORDER BY id').all<AppRow>()
		return results
	}

	async getApp(id: string): Promise<AppRow | null> {
		return this.d1.prepare('SELECT * FROM apps WHERE id = ?').bind(id).first<AppRow>()
	}

	/** Exact repository, connection and installation lookup for a connection-scoped webhook. */
	async getAppsByRepoUrlAndSourceConnection(
		repoUrl: string,
		connectionId: string,
		installationId: number,
	): Promise<AppRow[]> {
		await this.validateConnectionSourceBinding(repoUrl, connectionId, installationId)
		const { results } = await this.d1.prepare(`SELECT a.* FROM apps a
			INNER JOIN github_source_connections_keyed c
				ON c.connection_id = a.github_connection_id
				AND c.installation_id = a.github_installation_id
			WHERE a.repo_url = ? AND a.github_connection_id = ? AND a.github_installation_id = ?
			ORDER BY a.id`)
			.bind(repoUrl, connectionId, installationId)
			.all<AppRow>()
		return results
	}

	/**
	 * The credential selector a deploy of this app hands its provider; null for a public source. Partial,
	 * stale and cross-owner bindings fail closed (ADR-0029).
	 */
	async getSourceBinding(appId: string): Promise<ProviderSourceBinding | null> {
		const row = await this.d1.prepare(`SELECT a.repo_url, a.github_connection_id, a.github_installation_id, c.app_owner
			FROM apps a
			LEFT JOIN github_source_connections_keyed c
				ON c.connection_id = a.github_connection_id
				AND c.installation_id = a.github_installation_id
			WHERE a.id = ?`).bind(appId).first<SourceBindingRow>()
		if (row === null) return null
		const connectionId = row.github_connection_id
		const installationId = row.github_installation_id
		if (connectionId === null && installationId === null) return null
		if (connectionId === null || installationId === null || row.app_owner === null) {
			throw new SourceBindingError('incomplete GitHub source binding')
		}
		const repositoryOwner = githubRepositoryOwner(row.repo_url)
		if (repositoryOwner === null || repositoryOwner.toLowerCase() !== row.app_owner.toLowerCase()) {
			throw new SourceBindingError('GitHub source binding does not own the repository')
		}
		return { connectionId, installationId }
	}

	/** Validate a proposed connection binding before the app row exists. */
	async validateConnectionSourceBinding(
		repoUrl: string,
		githubConnectionId: string | null,
		githubInstallationId: number | null,
	): Promise<ProviderSourceBinding | null> {
		if (githubConnectionId === null && githubInstallationId === null) return null
		if (githubConnectionId === null || githubInstallationId === null) throw new SourceBindingError('incomplete GitHub source binding')
		const row = await this.d1.prepare(`SELECT app_owner
			FROM github_source_connections_keyed WHERE connection_id = ? AND installation_id = ?`)
			.bind(githubConnectionId, githubInstallationId)
			.first<{ app_owner: string }>()
		if (row === null) throw new SourceBindingError('unknown GitHub source binding')
		const repositoryOwner = githubRepositoryOwner(repoUrl)
		if (repositoryOwner === null || repositoryOwner.toLowerCase() !== row.app_owner.toLowerCase()) {
			throw new SourceBindingError('GitHub source binding does not own the repository')
		}
		return { connectionId: githubConnectionId, installationId: githubInstallationId }
	}

	/** A stored connection binding must still name a connection that owns the repository. */
	private async assertStoredSourceConnection(appId: string): Promise<void> {
		const app = await this.getApp(appId)
		if (app === null || app.github_connection_id === null) return
		await this.validateConnectionSourceBinding(app.repo_url, app.github_connection_id, app.github_installation_id)
	}

	async createApp(input: AppInput): Promise<AppRow> {
		return firstRow<AppRow>(this.appInsertStatement(input))
	}

	private appInsertStatement(input: AppInput): SqlStatement {
		return this.d1
			.prepare(`INSERT INTO apps (
				id, repo_url, default_branch, worker_dir, build_cmd, config_path,
				github_connection_id, github_installation_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
			.bind(
				input.id,
				input.repoUrl,
				input.defaultBranch ?? 'main',
				input.workerDir ?? null,
				input.buildCmd ?? null,
				input.configPath ?? null,
				input.githubConnectionId ?? null,
				input.githubInstallationId ?? null,
			)
	}

	async updateApp(id: string, patch: {
		repoUrl?: string
		defaultBranch?: string
		workerDir?: string | null
		buildCmd?: string | null
		configPath?: string | null
		githubConnectionId?: string | null
		githubInstallationId?: number | null
	}): Promise<AppRow | null> {
		return this.d1
			.prepare(`UPDATE apps SET
				repo_url = COALESCE(?, repo_url),
				default_branch = COALESCE(?, default_branch),
				worker_dir = COALESCE(?, worker_dir),
				build_cmd = COALESCE(?, build_cmd),
				config_path = COALESCE(?, config_path),
				github_connection_id = CASE WHEN ? = 1 THEN ? ELSE github_connection_id END,
				github_installation_id = CASE WHEN ? = 1 THEN ? ELSE github_installation_id END
				WHERE id = ? RETURNING *`)
			.bind(
				patch.repoUrl ?? null,
				patch.defaultBranch ?? null,
				patch.workerDir ?? null,
				patch.buildCmd ?? null,
				patch.configPath ?? null,
				patch.githubConnectionId === undefined ? 0 : 1,
				patch.githubConnectionId ?? null,
				patch.githubInstallationId === undefined ? 0 : 1,
				patch.githubInstallationId ?? null,
				id,
			)
			.first<AppRow>()
	}

	/** Atomically replace or clear both GitHub source coordinates, including explicit NULL values. */
	async replaceAppGitHubSourceBinding(
		id: string,
		binding: { readonly connectionId: string | null; readonly installationId: number | null },
	): Promise<AppRow | null> {
		if (binding.connectionId !== null && binding.connectionId.trim() === '') throw new Error('invalid GitHub source connection id')
		if (binding.installationId !== null && (!Number.isSafeInteger(binding.installationId) || binding.installationId <= 0)) {
			throw new Error('invalid GitHub installation id')
		}
		return this.updateApp(id, {
			githubConnectionId: binding.connectionId,
			githubInstallationId: binding.installationId,
		})
	}

	/**
	 * Delete an app and its environments, each leaving its protection row (`appEnvTombstoneSql`). With `expected`, the
	 * delete applies only while the app has exactly those environments at those generations; otherwise it throws
	 * `AppEnvChangedError`. False when the app does not exist.
	 */
	async deleteApp(id: string, expected?: readonly { readonly env: string; readonly generation: number }[]): Promise<boolean> {
		const unchanged = expected === undefined
			? { sql: '', values: [] }
			: {
				sql: ` AND (SELECT COUNT(*) FROM app_envs WHERE app_id = ?) = ?
					AND NOT EXISTS (SELECT 1 FROM app_envs WHERE app_id = ? AND NOT (${
					expected.length === 0 ? '1 = 0' : expected.map(() => '(env = ? AND generation = ?)').join(' OR ')
				}))`,
				values: [id, expected.length, id, ...expected.flatMap((row) => [row.env, row.generation])],
			}
		const lock = appCoordinateLockStatements(this.d1, id)
		const results = await this.d1.batch([
			...lock,
			this.d1.prepare(`${appEnvTombstoneSql} WHERE app_id = ? ${APP_ENV_TOMBSTONE_CONFLICT}`).bind(id),
			this.d1.prepare(`DELETE FROM apps WHERE id = ?${unchanged.sql} RETURNING id`).bind(id, ...unchanged.values),
		])
		if ((results[lock.length + 1]?.results.length ?? 0) > 0) return true
		if (expected !== undefined && (await this.getApp(id)) !== null) throw new AppEnvChangedError(id, '*')
		return false
	}

	// ── Deployment namespaces ─────────────────────────────────────────────────

	async listDeploymentNamespaces(): Promise<DeploymentNamespaceRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM deployment_namespaces ORDER BY env, id')
			.all<DeploymentNamespaceRow>()
		return results
	}

	async getDeploymentNamespace(id: string): Promise<DeploymentNamespaceRow | null> {
		return this.d1.prepare('SELECT * FROM deployment_namespaces WHERE id = ?').bind(id).first<DeploymentNamespaceRow>()
	}

	async createDeploymentNamespace(input: DeploymentNamespaceInput): Promise<DeploymentNamespaceRow> {
		return firstRow<DeploymentNamespaceRow>(this.deploymentNamespaceInsertStatement(input))
	}

	/** Create a namespace and reserve all provider-owned keys in one transaction. */
	async createDeploymentNamespaceWithResourceClaims(
		input: DeploymentNamespaceInput,
		resourceKeys: readonly string[],
	): Promise<DeploymentNamespaceRow> {
		const results = await this.d1.batch<DeploymentNamespaceRow | NamespaceResourceClaimRow>([
			this.deploymentNamespaceInsertStatement(input),
			...this.namespaceResourceClaimStatements({
				namespaceId: input.id,
				ownerAppId: null,
				ownerEnv: null,
				resourceKeys,
			}),
		])
		const namespace = results[0]?.results[0]
		if (namespace === undefined || !('state' in namespace) || results[0]?.results.length !== 1) {
			throw new Error('expected one row from a deployment namespace insert')
		}
		return namespace
	}

	private deploymentNamespaceInsertStatement(input: DeploymentNamespaceInput): SqlStatement {
		return this.d1
			.prepare(`INSERT INTO deployment_namespaces (
					id, env, provider, exclusive_app_id, provider_target_json, state, last_error
				)
				VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
			.bind(
				input.id,
				input.env,
				input.provider,
				input.exclusiveAppId,
				input.providerTargetJson,
				input.state ?? 'pending',
				input.lastError ?? null,
			)
	}

	/**
	 * The lease store whose `deploy_locks` rows this repository's fenced namespace writes check, for a
	 * request that takes a `namespace:<id>` lease itself.
	 */
	namespaceLocks(): DeployLocks {
		return new SqlDeployLocks(this.d1)
	}

	/** Lock the holder's lease row for the batch it leads: an EXISTS alone races takeover on Postgres. */
	private namespaceLeaseLockStatement(id: string, fence: LeaseFence): SqlStatement {
		return this.d1.prepare('UPDATE deploy_locks SET holder = holder WHERE lock_key = ? AND holder = ? AND expires_at > ?')
			.bind(namespaceLeaseKey(id), fence.holder, fence.nowMs)
	}

	/** One namespace write by the holder of its `namespace:<id>` lease; `created_at` pins the row's identity. */
	async writeDeploymentNamespace(input: {
		id: string
		createdAt: number
		fence: LeaseFence
		providerTargetJson: string
		state: DeploymentNamespaceState
		lastError: string | null
		/** Only the job that claims a `pending` row may move it; any other write leaves a requeue in place. */
		claim: boolean
	}): Promise<boolean> {
		const key = namespaceLeaseKey(input.id)
		const results = await this.d1.batch<{ id: string }>([
			this.namespaceLeaseLockStatement(input.id, input.fence),
			this.d1.prepare(`UPDATE deployment_namespaces
				SET provider_target_json = ?, state = CASE WHEN state = 'pending' AND ? = 0 THEN 'pending' ELSE ? END, last_error = ?
				WHERE id = ? AND created_at = ?
					AND EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)
				RETURNING id`)
				.bind(
					input.providerTargetJson,
					input.claim ? 1 : 0,
					input.state,
					input.lastError,
					input.id,
					input.createdAt,
					key,
					input.fence.holder,
					input.fence.nowMs,
				),
		])
		return (results[1]?.results.length ?? 0) > 0
	}

	/**
	 * Move one namespace from exactly the `state` and `last_error` its lease holder read, in one fenced
	 * write. NULL = the row moved meanwhile, or the lease is gone; the caller must not assume it landed.
	 * `COALESCE` compares a NULL `last_error` the same way on SQLite and Postgres. A move to `ready` clears
	 * the mark, and lands `pending` instead when a repair was requested meanwhile: the caller queues it.
	 */
	async transitionDeploymentNamespace(input: {
		id: string
		createdAt: number
		fence: LeaseFence
		from: { state: DeploymentNamespaceState; lastError: string | null }
		to: { state: DeploymentNamespaceState; providerTargetJson: string; lastError: string | null; updateTargetJson: string | null }
	}): Promise<DeploymentNamespaceRow | null> {
		const clearing = input.to.state === 'ready' ? 1 : 0
		const results = await this.d1.batch<DeploymentNamespaceRow>([
			this.namespaceLeaseLockStatement(input.id, input.fence),
			this.d1.prepare(`UPDATE deployment_namespaces
				SET state = CASE WHEN ? = 1 AND repair_requested = 1 THEN 'pending' ELSE ? END,
					provider_target_json = ?, last_error = ?, update_target_json = ?,
					repair_requested = CASE WHEN ? = 1 THEN 0 ELSE repair_requested END
				WHERE id = ? AND created_at = ? AND state = ? AND COALESCE(last_error, '') = ?
					AND EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)
				RETURNING *`)
				.bind(
					clearing,
					input.to.state,
					input.to.providerTargetJson,
					input.to.lastError,
					input.to.updateTargetJson,
					clearing,
					input.id,
					input.createdAt,
					input.from.state,
					input.from.lastError ?? '',
					namespaceLeaseKey(input.id),
					input.fence.holder,
					input.fence.nowMs,
				),
		])
		return results[1]?.results[0] ?? null
	}

	/**
	 * Queue a namespace for another provider mutation. It never writes `provider_target_json`, so a request
	 * that arrives while a job is in flight cannot roll back a checkpoint the worker has just written; the
	 * job keeps the `pending` state (only a claim moves it) and the queued job runs after it. A row an
	 * update marked keeps its state — re-applying its stored target would fight the live change it does
	 * not describe yet — and records the request instead, which the update's clearing write replays. The
	 * caller tells the two apart with `isUnconfirmedNamespaceUpdate`. NULL = already pending.
	 */
	async requeueDeploymentNamespace(id: string): Promise<DeploymentNamespaceRow | null> {
		return this.d1
			.prepare(`UPDATE deployment_namespaces
				SET state = CASE WHEN update_target_json IS NULL THEN 'pending' ELSE state END,
					last_error = CASE WHEN update_target_json IS NULL THEN NULL ELSE last_error END,
					repair_requested = CASE WHEN update_target_json IS NULL THEN repair_requested ELSE 1 END
				WHERE id = ? AND state IN ('ready', 'failed', 'provisioning') RETURNING *`)
			.bind(id)
			.first<DeploymentNamespaceRow>()
	}

	/**
	 * Remove one namespace and release its reservations in ONE transaction, freeing the id for reuse
	 * (backlog 73). Claims go first because both foreign keys are `ON DELETE RESTRICT`, and BOTH
	 * statements carry the SAME guard, so a removal refused between the caller's check and this write
	 * cannot strip the claims of a namespace it then leaves in place. NULL = refused; the caller re-reads
	 * the row to say why. It deletes no provider resource — that stays with the operator (ADR-0034). A row
	 * an update marked is kept: the only way out of that state is the update's retry.
	 */
	async deleteDeploymentNamespaceWithResourceClaims(id: string): Promise<DeploymentNamespaceRow | null> {
		const removable = `state <> 'provisioning' AND update_target_json IS NULL AND NOT EXISTS (SELECT 1 FROM app_envs WHERE namespace_id = ?)`
		const results = await this.d1.batch<DeploymentNamespaceRow | NamespaceResourceClaimRow>([
			this.d1
				.prepare(`DELETE FROM namespace_resource_claims
					WHERE namespace_id = ?
						AND EXISTS (SELECT 1 FROM deployment_namespaces WHERE id = ? AND ${removable})`)
				.bind(id, id, id),
			this.d1
				.prepare(`DELETE FROM deployment_namespaces WHERE id = ? AND ${removable} RETURNING *`)
				.bind(id, id),
		])
		const removed = results[1]?.results[0]
		if (removed === undefined) {
			return null
		}
		if (!('state' in removed)) {
			throw new Error('expected a deployment namespace row from a namespace delete')
		}
		return removed
	}

	async listNamespaceResourceClaims(namespaceId: string): Promise<NamespaceResourceClaimRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM namespace_resource_claims WHERE namespace_id = ? ORDER BY resource_key')
			.bind(namespaceId)
			.all<NamespaceResourceClaimRow>()
		return results
	}

	/**
	 * Every claim one app — or one of its environments — still owns, in any namespace. Both owner
	 * foreign keys are `ON DELETE RESTRICT`, so this is what a registry delete must read before it tries.
	 */
	async listNamespaceResourceClaimsForApp(appId: string, env?: string): Promise<NamespaceResourceClaimRow[]> {
		const statement = env === undefined
			? this.d1
				.prepare(`SELECT * FROM namespace_resource_claims
					WHERE owner_app_id = ?
					ORDER BY namespace_id, resource_key`)
				.bind(appId)
			: this.d1
				.prepare(`SELECT * FROM namespace_resource_claims
					WHERE owner_app_id = ? AND owner_env = ?
					ORDER BY namespace_id, resource_key`)
				.bind(appId, env)
		const { results } = await statement.all<NamespaceResourceClaimRow>()
		return results
	}

	async createNamespaceResourceClaim(input: {
		namespaceId: string
		resourceKey: string
		ownerAppId: string | null
		ownerEnv: string | null
	}): Promise<NamespaceResourceClaimRow> {
		const [claim] = await this.acquireNamespaceResourceClaims({
			namespaceId: input.namespaceId,
			ownerAppId: input.ownerAppId,
			ownerEnv: input.ownerEnv,
			resourceKeys: [input.resourceKey],
		})
		if (claim === undefined) {
			throw new Error('expected an acquired namespace resource claim')
		}
		return claim
	}

	/**
	 * Atomically acquires every requested key for one owner. Existing keys owned by the same owner
	 * are idempotent; the schema trigger aborts the whole batch when any key has another owner.
	 */
	async acquireNamespaceResourceClaims(input: NamespaceResourceClaimOwner): Promise<NamespaceResourceClaimRow[]> {
		const statements = this.namespaceResourceClaimStatements(input)
		if (statements.length === 0) {
			return []
		}
		const results = await this.withNamespaceResourceClaimConflict(input, () => this.d1.batch<NamespaceResourceClaimRow>(statements))
		const claims: NamespaceResourceClaimRow[] = []
		for (const result of results) {
			const [claim] = result.results
			if (claim === undefined || result.results.length !== 1) {
				throw new Error('expected one row from a namespace resource claim acquisition')
			}
			claims.push(claim)
		}
		return claims
	}

	/** Release only one app environment's claims during failed provider registration preparation. */
	async deleteNamespaceResourceClaimsForOwner(namespaceId: string, ownerAppId: string, ownerEnv: string): Promise<void> {
		await this.d1
			.prepare(`DELETE FROM namespace_resource_claims
				WHERE namespace_id = ? AND owner_app_id = ? AND owner_env = ?`)
			.bind(namespaceId, ownerAppId, ownerEnv)
			.run()
	}

	// ── App environments ──────────────────────────────────────────────────────

	async listAppEnvs(appId: string): Promise<AppEnvRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_envs WHERE app_id = ? ORDER BY env')
			.bind(appId)
			.all<AppEnvRow>()
		return results
	}

	async getAppEnv(appId: string, env: string): Promise<AppEnvRow | null> {
		return this.d1.prepare('SELECT * FROM app_envs WHERE app_id = ? AND env = ?').bind(appId, env).first<AppEnvRow>()
	}

	/** Every app environment owned by one statically composed provider. */
	async listAppEnvsByProvider(provider: string): Promise<AppEnvRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT * FROM app_envs
				WHERE provider = ?
				ORDER BY app_id, env`)
			.bind(provider)
			.all<AppEnvRow>()
		return results
	}

	/** Every app environment named `env` that has published a snapshot: the applications a connector edge can join. */
	async listPublishedAppEnvsNamed(env: string): Promise<AppEnvRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT * FROM app_envs
				WHERE env = ? AND published_snapshot_json IS NOT NULL
				ORDER BY app_id`)
			.bind(env)
			.all<AppEnvRow>()
		return results
	}

	async listAppEnvsByNamespace(namespaceId: string): Promise<AppEnvRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT * FROM app_envs
				WHERE namespace_id = ?
				ORDER BY app_id, env`)
			.bind(namespaceId)
			.all<AppEnvRow>()
		return results
	}

	/** Every environment an operator marked as an MCP authoring target. */
	async listAuthoringAppEnvs(): Promise<AppEnvRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_envs WHERE authoring = 1 ORDER BY app_id, env')
			.all<AppEnvRow>()
		return results
	}

	/**
	 * Find the (app, env) a push ref triggers by EXACT trigger_ref. Kept for exact lookups; the webhook
	 * uses `listTriggerEnvs` + `refMatches` instead so a glob trigger_ref (`refs/tags/v*`) also matches.
	 */
	async getAppEnvByTriggerRef(appId: string, triggerRef: string): Promise<AppEnvRow | null> {
		return this.d1
			.prepare('SELECT * FROM app_envs WHERE app_id = ? AND trigger_ref = ?')
			.bind(appId, triggerRef)
			.first<AppEnvRow>()
	}

	/**
	 * Every env of an app that has a trigger_ref (exact or glob). The webhook fetches these and matches
	 * the pushed ref against each via `refMatches` (glob-aware) — the set per app is tiny, so matching in
	 * TS keeps the glob logic pure + testable rather than encoding it in SQL.
	 */
	async listTriggerEnvs(appId: string): Promise<AppEnvRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_envs WHERE app_id = ? AND trigger_ref IS NOT NULL ORDER BY env')
			.bind(appId)
			.all<AppEnvRow>()
		return results
	}

	/** Every env whose trigger_ref lacks the `refs/` prefix: rows `0009_canonical_trigger_refs.sql` had to leave bare. */
	async listBareTriggerEnvs(): Promise<AppEnvRow[]> {
		const { results } = await this.d1
			.prepare("SELECT * FROM app_envs WHERE trigger_ref IS NOT NULL AND substr(trigger_ref, 1, 5) <> 'refs/' ORDER BY app_id, env")
			.all<AppEnvRow>()
		return results
	}

	/**
	 * Upsert an (app, env) target. ON CONFLICT (app_id, env) overwrites the mutable columns and advances `generation`.
	 * With `expected`, the write applies only if the environment is still what the caller read (`AppEnvChangedError`).
	 */
	async upsertAppEnv(input: AppEnvInput, expected?: AppEnvExpectation): Promise<AppEnvRow> {
		return (await this.writeAppEnv(input, [], expected)).appEnv
	}

	/**
	 * Atomically upsert an environment and acquire its current resource keys. Keys omitted by a
	 * later call remain claimed; releasing a provider resource requires a separate explicit policy.
	 */
	async upsertAppEnvWithNamespaceResourceClaims(
		input: AppEnvInput,
		resourceKeys: readonly string[],
		expected?: AppEnvExpectation,
	): Promise<{ appEnv: AppEnvRow; resourceClaims: NamespaceResourceClaimRow[] }> {
		if (input.namespaceId === null) {
			throw new Error('namespace resource claims require an environment namespace')
		}
		return this.writeAppEnv(input, resourceKeys, expected)
	}

	/**
	 * One environment write and its namespace claims, in one transaction under the coordinate lock. With `expected`, a
	 * write that finds the environment changed fails the whole transaction (`expectedAppEnvWrite`), so no claim of it
	 * commits either.
	 */
	private async writeAppEnv(
		input: AppEnvInput,
		resourceKeys: readonly string[],
		expected: AppEnvExpectation | undefined,
	): Promise<{ appEnv: AppEnvRow; resourceClaims: NamespaceResourceClaimRow[] }> {
		await this.assertStoredSourceConnection(input.appId)
		const lock = [appRowLockStatement(this.d1, input.appId), ...coordinateLockStatements(this.d1, input.appId, input.env)]
		const write = expected === undefined ? { statements: [this.appEnvUpsertStatement(input)], envAt: 0 } : this.expectedAppEnvWrite(input, expected)
		const owner: NamespaceResourceClaimOwner | null = input.namespaceId === null || resourceKeys.length === 0
			? null
			: { namespaceId: input.namespaceId, ownerAppId: input.appId, ownerEnv: input.env, resourceKeys }
		const statements = [...lock, ...write.statements, ...(owner === null ? [] : this.namespaceResourceClaimStatements(owner))]
		const run = () => this.withTriggerRefConflict(input, () => this.d1.batch<AppEnvRow | NamespaceResourceClaimRow>(statements))
		const claimed = owner === null ? run : () => this.withNamespaceResourceClaimConflict(owner, run)
		const results = expected === undefined ? await claimed() : await this.expectedWrite(input, expected, claimed)
		const envResult = results[lock.length + write.envAt]
		const appEnv = envResult?.results[0]
		if (appEnv === undefined || !('provider' in appEnv) || envResult?.results.length !== 1) {
			throw new Error('expected one row from an app environment write')
		}
		return { appEnv, resourceClaims: claimRows(results.slice(lock.length + write.statements.length)) }
	}

	/** A failed write is a trigger-ref conflict when another environment of the app holds the ref (`idx_app_envs_trigger`). */
	private async withTriggerRefConflict<T>(input: AppEnvInput, write: () => Promise<T>): Promise<T> {
		try {
			return await write()
		} catch (cause) {
			const triggerRef = input.triggerRef ?? null
			const holder = triggerRef === null ? null : await this.getAppEnvByTriggerRef(input.appId, triggerRef)
			if (triggerRef !== null && holder !== null && holder.env !== input.env) {
				throw new AppEnvTriggerRefConflictError(input.appId, input.env, triggerRef, holder.env)
			}
			throw cause
		}
	}

	/** A failed conditional write is a conflict when the environment is no longer what the caller read. */
	private async expectedWrite<T>(input: AppEnvInput, expected: AppEnvExpectation, write: () => Promise<T>): Promise<T> {
		try {
			return await write()
		} catch (cause) {
			const current = await this.getAppEnv(input.appId, input.env)
			const unchanged = 'absent' in expected ? current === null : current?.generation === expected.generation
			if (!unchanged) throw new AppEnvChangedError(input.appId, input.env)
			throw cause
		}
	}

	/** Create an app, its first namespaced environment, and all claims in one transaction. */
	async createAppWithEnvironmentAndNamespaceResourceClaims(
		appInput: AppInput,
		environmentInput: AppEnvInput,
		resourceKeys: readonly string[],
	): Promise<{ app: AppRow; appEnv: AppEnvRow; resourceClaims: NamespaceResourceClaimRow[] }> {
		if (environmentInput.namespaceId === null) {
			throw new Error('namespace resource claims require an environment namespace')
		}
		if (appInput.id !== environmentInput.appId) {
			throw new Error('app and environment coordinates do not match')
		}
		if ((appInput.githubConnectionId ?? null) !== null) {
			await this.validateConnectionSourceBinding(
				appInput.repoUrl,
				appInput.githubConnectionId ?? null,
				appInput.githubInstallationId ?? null,
			)
		}
		const owner: NamespaceResourceClaimOwner = {
			namespaceId: environmentInput.namespaceId,
			ownerAppId: environmentInput.appId,
			ownerEnv: environmentInput.env,
			resourceKeys,
		}
		const lock = coordinateLockStatements(this.d1, environmentInput.appId, environmentInput.env)
		const results = await this.withNamespaceResourceClaimConflict(owner, () =>
			this.d1.batch<AppRow | AppEnvRow | NamespaceResourceClaimRow>([
				this.appInsertStatement(appInput),
				...lock,
				this.appEnvUpsertStatement(environmentInput),
				...this.namespaceResourceClaimStatements(owner),
			]))
		const envAt = 1 + lock.length
		const app = results[0]?.results[0]
		const appEnv = results[envAt]?.results[0]
		if (app === undefined || !('id' in app) || results[0]?.results.length !== 1) {
			throw new Error('expected one row from an app insert')
		}
		if (appEnv === undefined || !('provider' in appEnv) || results[envAt]?.results.length !== 1) {
			throw new Error('expected one row from an app environment upsert')
		}
		return { app, appEnv, resourceClaims: claimRows(results.slice(envAt + 1)) }
	}

	private appEnvUpsertStatement(input: AppEnvInput): SqlStatement {
		return this.d1
			.prepare(`${APP_ENV_INSERT_SQL}
				ON CONFLICT (app_id, env) DO UPDATE SET
					domain = excluded.domain,
					public_origin = excluded.public_origin,
					trigger_ref = excluded.trigger_ref,
					namespace_id = excluded.namespace_id,
					provider = excluded.provider,
					provider_target_json = excluded.provider_target_json,
					provider_artifact_json = excluded.provider_artifact_json,
					authoring = COALESCE(?, app_envs.authoring),
					generation = app_envs.generation + 1
				RETURNING *`)
			.bind(...appEnvInsertValues(input), authoringFlag(input.authoring))
	}

	/**
	 * A write conditional on what the caller read, under the coordinate lock. A new environment is a plain insert, which
	 * fails on the key when one exists. An existing one is checked first: when it is not at the generation the caller read,
	 * the check inserts a duplicate of the locked protection row, and the unique key fails the transaction.
	 */
	private expectedAppEnvWrite(input: AppEnvInput, expected: AppEnvExpectation): { readonly statements: SqlStatement[]; readonly envAt: number } {
		if ('absent' in expected) {
			return { statements: [this.d1.prepare(`${APP_ENV_INSERT_SQL} RETURNING *`).bind(...appEnvInsertValues(input))], envAt: 0 }
		}
		const check = this.d1
			.prepare(`INSERT INTO app_env_protection (app_id, env, protected, generation, protection_revision)
				SELECT app_id, env, protected, generation, protection_revision FROM app_env_protection
				WHERE app_id = ? AND env = ? AND NOT EXISTS (SELECT 1 FROM app_envs WHERE app_id = ? AND env = ? AND generation = ?)`)
			.bind(input.appId, input.env, input.appId, input.env, expected.generation)
		const update = this.d1
			.prepare(`UPDATE app_envs SET
					domain = ?, public_origin = ?, trigger_ref = ?, namespace_id = ?, provider = ?,
					provider_target_json = ?, provider_artifact_json = ?, authoring = COALESCE(?, authoring),
					generation = generation + 1
				WHERE app_id = ? AND env = ? AND generation = ?
				RETURNING *`)
			.bind(
				input.domain ?? null,
				input.publicOrigin ?? null,
				input.triggerRef ?? null,
				input.namespaceId,
				input.provider,
				input.providerTargetJson,
				input.providerArtifactJson,
				authoringFlag(input.authoring),
				input.appId,
				input.env,
				expected.generation,
			)
		return { statements: [check, update], envAt: 1 }
	}

	private namespaceResourceClaimStatements(input: NamespaceResourceClaimOwner): SqlStatement[] {
		if ((input.ownerAppId === null) !== (input.ownerEnv === null)) {
			throw new Error('namespace resource claim owner app and environment must both be set or both be null')
		}
		return [...new Set(input.resourceKeys)].sort().map((resourceKey) =>
			this.d1
				.prepare(`INSERT INTO namespace_resource_claims (
					namespace_id, resource_key, owner_app_id, owner_env
				)
				VALUES (?, ?, ?, ?)
				ON CONFLICT (namespace_id, resource_key) DO UPDATE SET
					owner_app_id = excluded.owner_app_id,
					owner_env = excluded.owner_env
				RETURNING *`)
				.bind(input.namespaceId, resourceKey, input.ownerAppId, input.ownerEnv)
		)
	}

	private async withNamespaceResourceClaimConflict<T>(
		input: NamespaceResourceClaimOwner,
		operation: () => Promise<T>,
	): Promise<T> {
		try {
			return await operation()
		} catch (cause) {
			const claims = await this.listNamespaceResourceClaims(input.namespaceId)
			const requested = new Set(input.resourceKeys)
			const conflict = claims.find((claim) =>
				requested.has(claim.resource_key)
				&& (claim.owner_app_id !== input.ownerAppId || claim.owner_env !== input.ownerEnv)
			)
			if (conflict !== undefined) {
				throw new NamespaceResourceClaimConflictError(input.namespaceId, conflict.resource_key)
			}
			throw cause
		}
	}

	/**
	 * Change an environment's `protected` flag (ADR-0050); the caller has authorized a human with `access.approve`. The
	 * change advances `generation`, so a run that classified under the old flag loses its publication, and the flag is
	 * kept for these coordinates beyond the environment's deletion. It is fenced on the environment's deployment lease
	 * and refused while a run is `running`: that run's job applies what the old flag allowed. Null when the environment is
	 * missing, the lease is lost or a run is running.
	 */
	async setAppEnvProtected(appId: string, env: string, value: boolean, fence: LeaseFence): Promise<AppEnvRow | null> {
		const key = runLeaseKey(appId, env)
		const leading = [
			this.d1.prepare('UPDATE deploy_locks SET holder = holder WHERE lock_key = ? AND holder = ? AND expires_at > ?').bind(
				key,
				fence.holder,
				fence.nowMs,
			),
			...coordinateLockStatements(this.d1, appId, env),
		]
		const results = await this.d1.batch<AppEnvRow>([
			...leading,
			this.d1.prepare(`UPDATE app_envs SET protected = ?, protection_revision = protection_revision + 1, generation = generation + 1
				WHERE app_id = ? AND env = ?
					AND EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)
					AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.app_id = app_envs.app_id AND runs.env = app_envs.env AND runs.status = 'running')
				RETURNING *`).bind(value ? 1 : 0, appId, env, key, fence.holder, fence.nowMs),
		])
		return results[leading.length]?.results[0] ?? null
	}

	/**
	 * Delete an environment, leaving its protection row (`appEnvTombstoneSql`). With `expected`, the delete applies only
	 * at the generation the caller read, whose protection it checked; otherwise it throws `AppEnvChangedError`.
	 */
	async deleteAppEnv(appId: string, env: string, expected?: number): Promise<boolean> {
		const at = expected === undefined ? { sql: '', values: [] } : { sql: ' AND generation = ?', values: [expected] }
		const lock = coordinateLockStatements(this.d1, appId, env)
		const results = await this.d1.batch([
			...lock,
			this.d1.prepare(`${appEnvTombstoneSql} WHERE app_id = ? AND env = ?${at.sql} ${APP_ENV_TOMBSTONE_CONFLICT}`).bind(appId, env, ...at.values),
			this.d1.prepare(`DELETE FROM app_envs WHERE app_id = ? AND env = ?${at.sql} RETURNING app_id`).bind(appId, env, ...at.values),
		])
		if ((results[lock.length + 1]?.results.length ?? 0) > 0) return true
		if (expected !== undefined && (await this.getAppEnv(appId, env)) !== null) throw new AppEnvChangedError(appId, env)
		return false
	}

	async hasSuccessfulRun(appId: string, env: string): Promise<boolean> {
		const row = await this.d1
			.prepare(`SELECT id FROM runs
				WHERE app_id = ? AND env = ? AND status = 'succeeded'
				LIMIT 1`)
			.bind(appId, env)
			.first<{ id: string }>()
		return row !== null
	}

	async hasInFlightRun(appId: string, env: string): Promise<boolean> {
		const row = await this.d1
			.prepare(`SELECT id FROM runs
				WHERE app_id = ? AND env = ? AND status IN ('pending', 'running')
				LIMIT 1`)
			.bind(appId, env)
			.first<{ id: string }>()
		return row !== null
	}

	// ── App secrets (the pipeline.secrets resolution seam; values live in the M4 vault) ──

	/**
	 * The secret rows that apply when deploying `app` to `env`: the all-env layer (env IS NULL) plus
	 * the env-specific layer. The caller layers by iterating in order, so the ORDER BY must put the
	 * WIDER (all-env) row of a name BEFORE the narrower one — last write wins. `ORDER BY name` alone
	 * leaves that tie unordered, and the two dialects break it differently (SQLite falls back to rowid;
	 * Postgres is free to return either, and its default NULLS LAST would invert it), so the layer is
	 * ranked explicitly with a CASE rather than left to `env` sorting.
	 */
	async getAppSecretsForEnv(appId: string, env: string): Promise<AppSecretRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT * FROM app_secrets WHERE app_id = ? AND (env IS NULL OR env = ?)
				ORDER BY name, CASE WHEN env IS NULL THEN 0 ELSE 1 END`)
			.bind(appId, env)
			.all<AppSecretRow>()
		return results
	}

	async listAppSecrets(appId: string): Promise<AppSecretRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_secrets WHERE app_id = ? ORDER BY name, env')
			.bind(appId)
			.all<AppSecretRow>()
		return results
	}

	/** Upsert a secret reference at its (app, env-or-all) layer. The value_ref points into the M4 vault. */
	async upsertAppSecret(input: { appId: string; env: string | null; name: string; valueRef: string }): Promise<AppSecretRow> {
		// NULL env is a distinct layer from a concrete env (partial unique indexes), so the conflict
		// target differs. Two prepared variants keep the ON CONFLICT target correct for each layer.
		if (input.env === null) {
			return firstRow<AppSecretRow>(
				this.d1
					.prepare(`INSERT INTO app_secrets (app_id, env, name, value_ref) VALUES (?, NULL, ?, ?)
						ON CONFLICT (app_id, name) WHERE env IS NULL DO UPDATE SET value_ref = excluded.value_ref
						RETURNING *`)
					.bind(input.appId, input.name, input.valueRef),
			)
		}
		return firstRow<AppSecretRow>(
			this.d1
				.prepare(`INSERT INTO app_secrets (app_id, env, name, value_ref) VALUES (?, ?, ?, ?)
					ON CONFLICT (app_id, env, name) WHERE env IS NOT NULL DO UPDATE SET value_ref = excluded.value_ref
					RETURNING *`)
				.bind(input.appId, input.env, input.name, input.valueRef),
		)
	}

	async deleteAppSecret(appId: string, env: string | null, name: string): Promise<boolean> {
		const result = input(env)
			? await this.d1.prepare('DELETE FROM app_secrets WHERE app_id = ? AND env = ? AND name = ?').bind(appId, env, name).run()
			: await this.d1.prepare('DELETE FROM app_secrets WHERE app_id = ? AND env IS NULL AND name = ?').bind(appId, name).run()
		return (result.meta.changes ?? 0) > 0

		// Local helper: NULL env needs `IS NULL` (a bound NULL never `= NULL`).
		function input(value: string | null): value is string {
			return value !== null
		}
	}

	// ── Proxy secrets (ADR-0022 rule 5; the value lives in the vault) ─────────────

	async getAppEnvProxySecretRef(appId: string, env: string): Promise<string | null> {
		const row = await this.d1
			.prepare('SELECT value_ref FROM app_env_proxy_secrets WHERE app_id = ? AND env = ?')
			.bind(appId, env)
			.first<{ value_ref: string }>()
		return row?.value_ref ?? null
	}

	/** Records `valueRef` as the environment's proxy secret unless it has one; true when this call recorded it. */
	async claimAppEnvProxySecretRef(appId: string, env: string, valueRef: string): Promise<boolean> {
		const result = await this.d1
			.prepare('INSERT INTO app_env_proxy_secrets (app_id, env, value_ref) VALUES (?, ?, ?) ON CONFLICT (app_id, env) DO NOTHING')
			.bind(appId, env, valueRef)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	// ── App vars (non-secret deploy-time config; PLAINTEXT, mirrors app_secrets' env layering) ──

	/**
	 * Vars visible to a deploy of `env`: the all-env layer (NULL) PLUS this env's, narrower wins (caller
	 * layers). Same explicit layer ranking as `getAppSecretsForEnv` — the all-env row must come first.
	 */
	async getAppVarsForEnv(appId: string, env: string): Promise<AppVarRow[]> {
		const { results } = await this.d1
			.prepare(`SELECT * FROM app_vars WHERE app_id = ? AND (env IS NULL OR env = ?)
				ORDER BY name, CASE WHEN env IS NULL THEN 0 ELSE 1 END`)
			.bind(appId, env)
			.all<AppVarRow>()
		return results
	}

	async listAppVars(appId: string): Promise<AppVarRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM app_vars WHERE app_id = ? ORDER BY name, env')
			.bind(appId)
			.all<AppVarRow>()
		return results
	}

	/** Upsert a plaintext var at its (app, env-or-all) layer. */
	async upsertAppVar(input: { appId: string; env: string | null; name: string; value: string }): Promise<AppVarRow> {
		// NULL env is a distinct layer from a concrete env (partial unique indexes), so the conflict
		// target differs — two prepared variants keep the ON CONFLICT target correct for each layer.
		if (input.env === null) {
			return firstRow<AppVarRow>(
				this.d1
					.prepare(`INSERT INTO app_vars (app_id, env, name, value) VALUES (?, NULL, ?, ?)
						ON CONFLICT (app_id, name) WHERE env IS NULL DO UPDATE SET value = excluded.value
						RETURNING *`)
					.bind(input.appId, input.name, input.value),
			)
		}
		return firstRow<AppVarRow>(
			this.d1
				.prepare(`INSERT INTO app_vars (app_id, env, name, value) VALUES (?, ?, ?, ?)
					ON CONFLICT (app_id, env, name) WHERE env IS NOT NULL DO UPDATE SET value = excluded.value
					RETURNING *`)
				.bind(input.appId, input.env, input.name, input.value),
		)
	}

	async deleteAppVar(appId: string, env: string | null, name: string): Promise<boolean> {
		const result = present(env)
			? await this.d1.prepare('DELETE FROM app_vars WHERE app_id = ? AND env = ? AND name = ?').bind(appId, env, name).run()
			: await this.d1.prepare('DELETE FROM app_vars WHERE app_id = ? AND env IS NULL AND name = ?').bind(appId, name).run()
		return (result.meta.changes ?? 0) > 0

		// Local helper: NULL env needs `IS NULL` (a bound NULL never `= NULL`).
		function present(value: string | null): value is string {
			return value !== null
		}
	}
}

interface SourceBindingRow {
	repo_url: string
	github_connection_id: string | null
	github_installation_id: number | null
	app_owner: string | null
}

function githubRepositoryOwner(repoUrl: string): string | null {
	const match = /^github\.com\/([^/]+)\/[^/]+$/.exec(repoUrl)
	return match?.[1] ?? null
}

const authoringFlag = (authoring: boolean | undefined): number | null => authoring === undefined ? null : authoring ? 1 : 0
