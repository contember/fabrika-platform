import { type DeployLocks, type SqlDatabase, SqlDeployLocks, type SqlStatement } from '@fabrika/platform'
import { PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED, type ProviderSourceBinding } from '@fabrika/provider-contract'
import { type LeaseFence, namespaceLeaseKey } from '../lease'
import {
	type AppEnvInput,
	type AppEnvRow,
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
 * The marker an in-flight or unconfirmed `namespaces.update` leaves on a row: state `failed` and a
 * `last_error` coded `PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED` (`<code>: <message>`).
 */
const UNCONFIRMED_UPDATE_PREFIX = `${PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED}: `

/** The same rule in SQL, so a statement cannot touch a marked row its caller read before the mark. The code holds no LIKE wildcard. */
const NOT_UNCONFIRMED_UPDATE = `NOT (state = 'failed' AND COALESCE(last_error, '') LIKE '${UNCONFIRMED_UPDATE_PREFIX}%')`

export function isUnconfirmedNamespaceUpdate(row: Pick<DeploymentNamespaceRow, 'state' | 'last_error'>): boolean {
	return row.state === 'failed' && row.last_error?.startsWith(UNCONFIRMED_UPDATE_PREFIX) === true
}

/** Portable registry persistence; a composition root may replace this complete capability. */
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

	async deleteApp(id: string): Promise<boolean> {
		const result = await this.d1.prepare('DELETE FROM apps WHERE id = ?').bind(id).run()
		return (result.meta.changes ?? 0) > 0
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
	 * `COALESCE` compares a NULL `last_error` the same way on SQLite and Postgres.
	 */
	async transitionDeploymentNamespace(input: {
		id: string
		createdAt: number
		fence: LeaseFence
		from: { state: DeploymentNamespaceState; lastError: string | null }
		to: { state: DeploymentNamespaceState; providerTargetJson: string; lastError: string | null }
	}): Promise<DeploymentNamespaceRow | null> {
		const results = await this.d1.batch<DeploymentNamespaceRow>([
			this.namespaceLeaseLockStatement(input.id, input.fence),
			this.d1.prepare(`UPDATE deployment_namespaces
				SET state = ?, provider_target_json = ?, last_error = ?
				WHERE id = ? AND created_at = ? AND state = ? AND COALESCE(last_error, '') = ?
					AND EXISTS (SELECT 1 FROM deploy_locks WHERE lock_key = ? AND holder = ? AND expires_at > ?)
				RETURNING *`)
				.bind(
					input.to.state,
					input.to.providerTargetJson,
					input.to.lastError,
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
	 * update marked is never matched: re-applying its stored target would fight the live change it does
	 * not describe yet. NULL = already pending, or marked.
	 */
	async requeueDeploymentNamespace(id: string): Promise<DeploymentNamespaceRow | null> {
		return this.d1
			.prepare(`UPDATE deployment_namespaces
				SET state = 'pending', last_error = NULL
				WHERE id = ? AND state IN ('ready', 'failed', 'provisioning') AND ${NOT_UNCONFIRMED_UPDATE} RETURNING *`)
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
		const removable = `state <> 'provisioning' AND ${NOT_UNCONFIRMED_UPDATE} AND NOT EXISTS (SELECT 1 FROM app_envs WHERE namespace_id = ?)`
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

	/** Upsert an (app, env) target. ON CONFLICT (app_id, env) overwrites the mutable columns. */
	async upsertAppEnv(input: AppEnvInput): Promise<AppEnvRow> {
		await this.assertStoredSourceConnection(input.appId)
		return firstRow<AppEnvRow>(this.appEnvUpsertStatement(input))
	}

	/**
	 * Atomically upsert an environment and acquire its current resource keys. Keys omitted by a
	 * later call remain claimed; releasing a provider resource requires a separate explicit policy.
	 */
	async upsertAppEnvWithNamespaceResourceClaims(
		input: AppEnvInput,
		resourceKeys: readonly string[],
	): Promise<{ appEnv: AppEnvRow; resourceClaims: NamespaceResourceClaimRow[] }> {
		if (input.namespaceId === null) {
			throw new Error('namespace resource claims require an environment namespace')
		}
		await this.assertStoredSourceConnection(input.appId)
		const owner: NamespaceResourceClaimOwner = {
			namespaceId: input.namespaceId,
			ownerAppId: input.appId,
			ownerEnv: input.env,
			resourceKeys,
		}
		const results = await this.withNamespaceResourceClaimConflict(owner, () =>
			this.d1.batch<AppEnvRow | NamespaceResourceClaimRow>([
				this.appEnvUpsertStatement(input),
				...this.namespaceResourceClaimStatements(owner),
			]))
		const [appResult, ...claimResults] = results
		const appEnv = appResult?.results[0]
		if (appEnv === undefined || !('provider' in appEnv) || appResult?.results.length !== 1) {
			throw new Error('expected one row from an app environment upsert')
		}
		const resourceClaims: NamespaceResourceClaimRow[] = []
		for (const result of claimResults) {
			const [claim] = result.results
			if (claim === undefined || !('resource_key' in claim) || result.results.length !== 1) {
				throw new Error('expected one row from a namespace resource claim acquisition')
			}
			resourceClaims.push(claim)
		}
		return { appEnv, resourceClaims }
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
		const results = await this.withNamespaceResourceClaimConflict(owner, () =>
			this.d1.batch<AppRow | AppEnvRow | NamespaceResourceClaimRow>([
				this.appInsertStatement(appInput),
				this.appEnvUpsertStatement(environmentInput),
				...this.namespaceResourceClaimStatements(owner),
			]))
		const app = results[0]?.results[0]
		const appEnv = results[1]?.results[0]
		if (app === undefined || !('id' in app) || results[0]?.results.length !== 1) {
			throw new Error('expected one row from an app insert')
		}
		if (appEnv === undefined || !('provider' in appEnv) || results[1]?.results.length !== 1) {
			throw new Error('expected one row from an app environment upsert')
		}
		const resourceClaims: NamespaceResourceClaimRow[] = []
		for (const result of results.slice(2)) {
			const claim = result.results[0]
			if (claim === undefined || !('resource_key' in claim) || result.results.length !== 1) {
				throw new Error('expected one row from a namespace resource claim acquisition')
			}
			resourceClaims.push(claim)
		}
		return { app, appEnv, resourceClaims }
	}

	private appEnvUpsertStatement(input: AppEnvInput): SqlStatement {
		return this.d1
			.prepare(`INSERT INTO app_envs (
					app_id, env, domain, public_origin, trigger_ref, namespace_id, provider,
					provider_target_json, provider_artifact_json, authoring
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0))
				ON CONFLICT (app_id, env) DO UPDATE SET
					domain = excluded.domain,
					public_origin = excluded.public_origin,
					trigger_ref = excluded.trigger_ref,
					namespace_id = excluded.namespace_id,
					provider = excluded.provider,
					provider_target_json = excluded.provider_target_json,
					provider_artifact_json = excluded.provider_artifact_json,
					authoring = COALESCE(?, app_envs.authoring)
				RETURNING *`)
			.bind(
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
				authoringFlag(input.authoring),
			)
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

	async deleteAppEnv(appId: string, env: string): Promise<boolean> {
		const result = await this.d1.prepare('DELETE FROM app_envs WHERE app_id = ? AND env = ?').bind(appId, env).run()
		return (result.meta.changes ?? 0) > 0
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
