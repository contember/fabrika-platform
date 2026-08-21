// Control-plane persistence capabilities. Portable operations use prepared statements via
// `db.prepare(...).bind(...)`; composition roots may replace one complete capability when a database
// needs a different operation shape. Row shapes mirror migrations/0001_init.sql. Caller-generated
// UUIDv7 ids and timestamps are bound by the runtime, never generated in SQL.
//
// The handle is the `SqlDatabase` PORT, not `D1Database` — a real D1 binding satisfies it structurally
// because the port deliberately has D1's shape.
//
// fabrika is single-account (see migrations/0003): the CF account/token + propustka coords are fabrika's
// OWN Worker config (src/env.ts), not a per-account registry table, so there is no `accounts` access here.

import { DEFAULT_OPERATIONS_SERVICE_KEY } from '@fabrika/operations-contract/catalog'
import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
import type { JsonValue } from '@fabrika/provider-contract'
import { GitHubConnectionStore, type GitHubSourceTransportKind } from './github-connection-store'
import { uuidv7 } from './uuid'

// ── Row shapes (snake_case, as migrations/0001_init.sql defines) ───────────────

export interface AppRow {
	id: string
	repo_url: string
	default_branch: string
	worker_dir: string | null
	build_cmd: string | null
	config_path: string | null
	github_connection_id: string | null
	github_installation_id: number | null
	created_at: number
}

export interface AppEnvRow {
	app_id: string
	env: string
	domain: string | null
	public_origin: string | null
	/** Optional provider-owned placement boundary. */
	namespace_id: string | null
	/** The statically composed provider that owns both envelopes. */
	provider: string
	/** Canonical target envelope returned by ControlProvider.normalizeRegistration. */
	provider_target_json: string
	/** Canonical artifact envelope returned by ControlProvider.normalizeRegistration. */
	provider_artifact_json: string
	/** Git ref that triggers a deploy here, e.g. `refs/heads/deploy/prod`. NULL = manual-only. */
	trigger_ref: string | null
	created_at: number
}

export type DeploymentNamespaceState = 'pending' | 'provisioning' | 'ready' | 'failed'

export interface DeploymentNamespaceRow {
	id: string
	env: string
	provider: string
	exclusive_app_id: string | null
	provider_target_json: string
	state: DeploymentNamespaceState
	last_error: string | null
	created_at: number
}

export interface NamespaceResourceClaimRow {
	namespace_id: string
	resource_key: string
	/** NULL with owner_env means the namespace itself owns the resource. */
	owner_app_id: string | null
	owner_env: string | null
	created_at: number
}

export interface AppEnvInput {
	appId: string
	env: string
	domain?: string | null
	publicOrigin?: string | null
	triggerRef?: string | null
	namespaceId: string | null
	provider: string
	providerTargetJson: string
	providerArtifactJson: string
}

export interface AppInput {
	id: string
	repoUrl: string
	defaultBranch?: string
	workerDir?: string | null
	buildCmd?: string | null
	configPath?: string | null
	githubConnectionId?: string | null
	githubInstallationId?: number | null
}

export interface ZeropsSourceBinding {
	readonly connectionId: string
	readonly installationId: number
	readonly transportKind: GitHubSourceTransportKind
}

export interface NamespaceResourceClaimOwner {
	namespaceId: string
	ownerAppId: string | null
	ownerEnv: string | null
	resourceKeys: readonly string[]
}

export class NamespaceResourceClaimConflictError extends Error {
	constructor(readonly namespaceId: string, readonly resourceKey: string) {
		super(`namespace resource claim owner is immutable: ${namespaceId}/${resourceKey}`)
		this.name = 'NamespaceResourceClaimConflictError'
	}
}

export interface DeploymentNamespaceInput {
	id: string
	env: string
	provider: string
	exclusiveAppId: string | null
	providerTargetJson: string
	state?: DeploymentNamespaceState
	lastError?: string | null
}

export interface AppSecretRow {
	app_id: string
	/** NULL = applies to every env of the app; set = that env only (narrower wins). */
	env: string | null
	name: string
	/** Store reference (`vault:`, `secretstore:`, or `zerops:`) — never the plaintext value. */
	value_ref: string
	created_at: number
}

export interface AppVarRow {
	app_id: string
	/** NULL = applies to every env of the app; set = that env only (narrower wins). */
	env: string | null
	name: string
	/** PLAINTEXT config value — these are non-secret per-app-env deploy vars, NOT vault secrets. */
	value: string
	created_at: number
}

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

/**
 * Per-(app, env) public-repo poll bookkeeping (migrations/0004_repo_poll.sql). One row per pollable
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

export interface OperationsCatalogProjectionRow {
	app_id: string
	env: string
	domain: string | null
	public_origin: string | null
	service_key: string
	credential_id: string
	public_key: string
}

export interface OperationsIngestConfigRow {
	app_id: string
	env: string
	service_key: string
	credential_id: string
	public_key: string
	ingest_project_id: string | null
	dsn: string | null
	activated_revision: number | string | null
	created_at: number | string
	updated_at: number | string
}

export interface AppliedOperationsIngestConfig {
	appId: string
	environment: string
	serviceKey: string
	credentialId: string
	ingestProjectId: string
	dsn: string
}

export interface OperationsReleaseSyncRow {
	run_id: string
	desired_revision: number | string
	applied_revision: number | string
	payload_json: string
	last_attempt_at: number | string | null
	last_success_at: number | string | null
	last_error: string | null
}

interface OperationsCatalogSyncStateRow {
	desired_revision: number | string
	applied_revision: number | string
	attempted_revision: number | string | null
	last_snapshot_hash: string
	applied_snapshot_hash: string
	last_attempt_at: number | string | null
	last_success_at: number | string | null
	last_error: string | null
}

export interface OperationsCatalogSyncState {
	desiredRevision: number
	appliedRevision: number
	attemptedRevision: number | null
	lastSnapshotHash: string
	appliedSnapshotHash: string
	lastAttemptAt: number | null
	lastSuccessAt: number | null
	lastError: string | null
}

/**
 * Run a statement that always returns exactly one row (an `INSERT/UPDATE … RETURNING` we know
 * matched). `.first<T>()` is typed `T | null`; this narrows it to `T`, throwing if the row is
 * unexpectedly absent (a programming/DB error, not normal flow). Mirrors propustka's `firstRow`.
 */
async function firstRow<T>(statement: SqlStatement): Promise<T> {
	const row = await statement.first<T>()
	if (row === null) {
		throw new Error('expected a row from a RETURNING statement, got none')
	}
	return row
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

	/**
	 * The apps registered for a repo URL (the webhook narrows by repo first, then by ref). A repo can
	 * back more than one app entry, so this returns all matches. Matched on the normalized URL (the
	 * caller normalizes both the stored and the incoming URL the same way — see normalizeRepoUrl).
	 */
	async getAppsByRepoUrl(repoUrl: string): Promise<AppRow[]> {
		const { results } = await this.d1.prepare('SELECT * FROM apps WHERE repo_url = ?').bind(repoUrl).all<AppRow>()
		return results
	}

	/** Exact repository, connection and installation lookup for a scoped Zerops webhook. */
	async getZeropsAppsByRepoUrlAndSourceBinding(
		repoUrl: string,
		connectionId: string,
		installationId: number,
	): Promise<AppRow[]> {
		await this.validateZeropsSourceBinding(repoUrl, connectionId, installationId)
		const { results } = await this.d1.prepare(`SELECT DISTINCT a.* FROM apps a
			INNER JOIN app_envs e ON e.app_id = a.id AND e.provider = 'zerops'
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
	 * Resolve the credential selector for one Zerops app environment. Public source is represented by
	 * neither coordinate. Partial, stale, cross-owner and cross-installation bindings fail closed.
	 */
	async getZeropsSourceBinding(appId: string, env: string): Promise<ZeropsSourceBinding | null> {
		const row = await this.d1.prepare(`SELECT
				a.repo_url, a.github_connection_id, a.github_installation_id,
				e.provider, c.transport_kind, c.app_owner
			FROM apps a
			INNER JOIN app_envs e ON e.app_id = a.id AND e.env = ?
			LEFT JOIN github_source_connections_keyed c
				ON c.connection_id = a.github_connection_id
				AND c.installation_id = a.github_installation_id
			WHERE a.id = ?`).bind(env, appId).first<ZeropsSourceBindingRow>()
		if (row === null || row.provider !== 'zerops') return null
		const connectionId = row.github_connection_id
		const installationId = row.github_installation_id
		if (connectionId === null && installationId === null) return null
		if (connectionId === null || installationId === null || row.transport_kind === null || row.app_owner === null) {
			throw new Error('incomplete Zerops GitHub source binding')
		}
		const repositoryOwner = githubRepositoryOwner(row.repo_url)
		if (repositoryOwner === null || repositoryOwner.toLowerCase() !== row.app_owner.toLowerCase()) {
			throw new Error('Zerops GitHub source binding does not own the repository')
		}
		return {
			connectionId,
			installationId,
			transportKind: parseGitHubSourceTransportKind(row.transport_kind),
		}
	}

	/** Validate a proposed Zerops registration before the app row exists. */
	async validateZeropsSourceBinding(
		repoUrl: string,
		githubConnectionId: string | null,
		githubInstallationId: number | null,
	): Promise<ZeropsSourceBinding | null> {
		if (githubConnectionId === null && githubInstallationId === null) return null
		if (githubConnectionId === null || githubInstallationId === null) throw new Error('incomplete Zerops GitHub source binding')
		const row = await this.d1.prepare(`SELECT transport_kind, app_owner
			FROM github_source_connections_keyed WHERE connection_id = ? AND installation_id = ?`)
			.bind(githubConnectionId, githubInstallationId)
			.first<ZeropsConnectionBindingRow>()
		if (row === null) throw new Error('unknown Zerops GitHub source binding')
		const repositoryOwner = githubRepositoryOwner(repoUrl)
		if (repositoryOwner === null || repositoryOwner.toLowerCase() !== row.app_owner.toLowerCase()) {
			throw new Error('Zerops GitHub source binding does not own the repository')
		}
		return {
			connectionId: githubConnectionId,
			installationId: githubInstallationId,
			transportKind: parseGitHubSourceTransportKind(row.transport_kind),
		}
	}

	async validateStoredZeropsSourceBinding(appId: string): Promise<ZeropsSourceBinding | null> {
		const app = await this.getApp(appId)
		if (app === null) return null
		return this.validateZeropsSourceBinding(app.repo_url, app.github_connection_id, app.github_installation_id)
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

	/** Persist a provider checkpoint or a core-owned namespace lifecycle transition. */
	async updateDeploymentNamespace(input: {
		id: string
		providerTargetJson: string
		state: DeploymentNamespaceState
		lastError: string | null
	}): Promise<DeploymentNamespaceRow | null> {
		return this.d1
			.prepare(`UPDATE deployment_namespaces
				SET provider_target_json = ?, state = ?, last_error = ?
				WHERE id = ? RETURNING *`)
			.bind(input.providerTargetJson, input.state, input.lastError, input.id)
			.first<DeploymentNamespaceRow>()
	}

	/**
	 * Queue a SETTLED namespace for another provider mutation. Guarded to the terminal states and it
	 * never writes `provider_target_json`, so a request that arrives while a job is in flight cannot
	 * overwrite a checkpoint the worker has just written. NULL = it was not settled; leave it alone.
	 */
	async requeueDeploymentNamespace(id: string): Promise<DeploymentNamespaceRow | null> {
		return this.d1
			.prepare(`UPDATE deployment_namespaces
				SET state = 'pending', last_error = NULL
				WHERE id = ? AND state IN ('ready', 'failed') RETURNING *`)
			.bind(id)
			.first<DeploymentNamespaceRow>()
	}

	async listNamespaceResourceClaims(namespaceId: string): Promise<NamespaceResourceClaimRow[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM namespace_resource_claims WHERE namespace_id = ? ORDER BY resource_key')
			.bind(namespaceId)
			.all<NamespaceResourceClaimRow>()
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
		if (input.provider === 'zerops') await this.validateStoredZeropsSourceBinding(input.appId)
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
		if (input.provider === 'zerops') await this.validateStoredZeropsSourceBinding(input.appId)
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
		if (environmentInput.provider === 'zerops') {
			await this.validateZeropsSourceBinding(
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
					provider_target_json, provider_artifact_json
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (app_id, env) DO UPDATE SET
					domain = excluded.domain,
					public_origin = excluded.public_origin,
					trigger_ref = excluded.trigger_ref,
					namespace_id = excluded.namespace_id,
					provider = excluded.provider,
					provider_target_json = excluded.provider_target_json,
					provider_artifact_json = excluded.provider_artifact_json
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

/**
 * Owns the apps⋈app_envs projection and its delivery cursor. The query deliberately excludes
 * provider envelopes: Operations receives only canonical registry coordinates and display metadata.
 */
export class OperationsCatalogRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	/** Record a registry mutation. Every mutation advances the desired revision, even while one is in flight. */
	async markDirty(): Promise<number> {
		const row = await firstRow<{ desired_revision: number | string }>(
			this.db
				.prepare(`UPDATE operations_catalog_sync
					SET desired_revision = desired_revision + 1
					WHERE singleton = 1
					RETURNING desired_revision`),
		)
		return catalogInteger(row.desired_revision, 'desired_revision')
	}

	/** Maintenance creates work only when no failed or coalesced revision is already pending. */
	async ensurePending(): Promise<number> {
		const row = await firstRow<{ desired_revision: number | string }>(
			this.db
				.prepare(`UPDATE operations_catalog_sync
					SET desired_revision = CASE
						WHEN desired_revision = applied_revision THEN desired_revision + 1
						ELSE desired_revision
					END
					WHERE singleton = 1
					RETURNING desired_revision`),
		)
		return catalogInteger(row.desired_revision, 'desired_revision')
	}

	/** Read one transactionally consistent revision + complete source snapshot. */
	async snapshot(): Promise<{ revision: number; sources: OperationsCatalogProjectionRow[] }> {
		const registered = await this.db.prepare('SELECT app_id, env FROM app_envs ORDER BY app_id, env').all<{ app_id: string; env: string }>()
		for (const row of registered.results) {
			await this.db
				.prepare(`INSERT INTO operations_ingest_configs
					(app_id, env, service_key, credential_id, public_key, ingest_project_id, dsn, activated_revision, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
					ON CONFLICT (app_id, env, service_key) DO NOTHING`)
				.bind(
					row.app_id,
					row.env,
					DEFAULT_OPERATIONS_SERVICE_KEY,
					uuidv7(),
					generateIngestPublicKey(),
					this.now(),
					this.now(),
				)
				.run()
		}
		const results = await this.db.batch<OperationsCatalogSyncStateRow | OperationsCatalogProjectionRow>([
			this.db.prepare(`SELECT
					desired_revision, applied_revision, attempted_revision,
					last_snapshot_hash, applied_snapshot_hash,
					last_attempt_at, last_success_at, last_error
				FROM operations_catalog_sync WHERE singleton = 1`),
			this.db.prepare(`SELECT e.app_id, e.env, e.domain, e.public_origin,
					c.service_key, c.credential_id, c.public_key
				FROM app_envs e
				JOIN apps a ON a.id = e.app_id
				JOIN operations_ingest_configs c ON c.app_id = e.app_id AND c.env = e.env
				ORDER BY e.app_id, e.env`),
		])
		const state = results[0]?.results[0]
		if (state === undefined || !('desired_revision' in state)) {
			throw new Error('operations catalog sync state is missing')
		}
		const sources: OperationsCatalogProjectionRow[] = []
		for (const row of results[1]?.results ?? []) {
			if (!('app_id' in row)) throw new Error('invalid operations catalog projection row')
			sources.push(row)
		}
		return {
			revision: catalogInteger(state.desired_revision, 'desired_revision'),
			sources,
		}
	}

	async getState(): Promise<OperationsCatalogSyncState> {
		const row = await this.db
			.prepare(`SELECT
					desired_revision, applied_revision, attempted_revision,
					last_snapshot_hash, applied_snapshot_hash,
					last_attempt_at, last_success_at, last_error
				FROM operations_catalog_sync WHERE singleton = 1`)
			.first<OperationsCatalogSyncStateRow>()
		if (row === null) throw new Error('operations catalog sync state is missing')
		return catalogState(row)
	}

	async markAttempt(revision: number, snapshotHash: string): Promise<void> {
		await this.db
			.prepare(`UPDATE operations_catalog_sync SET
					attempted_revision = ?,
					last_snapshot_hash = ?,
					last_attempt_at = ?
				WHERE singleton = 1`)
			.bind(revision, snapshotHash, this.now())
			.run()
	}

	async markApplied(revision: number, snapshotHash: string, configs: readonly AppliedOperationsIngestConfig[]): Promise<void> {
		await this.db.batch([
			...configs.map((config) =>
				this.db
					.prepare(`UPDATE operations_ingest_configs SET
							ingest_project_id = ?,
							dsn = ?,
							activated_revision = ?,
							updated_at = ?
						WHERE app_id = ? AND env = ? AND service_key = ? AND credential_id = ?`)
					.bind(
						config.ingestProjectId,
						config.dsn,
						revision,
						this.now(),
						config.appId,
						config.environment,
						config.serviceKey,
						config.credentialId,
					)
			),
			this.db
				.prepare(`UPDATE operations_catalog_sync SET
					applied_revision = CASE WHEN applied_revision < ? THEN ? ELSE applied_revision END,
					applied_snapshot_hash = CASE WHEN applied_revision <= ? THEN ? ELSE applied_snapshot_hash END,
					last_success_at = ?,
					last_error = NULL
				WHERE singleton = 1`)
				.bind(revision, revision, revision, snapshotHash, this.now()),
		])
	}

	getIngestConfig(appId: string, environment: string, serviceKey = DEFAULT_OPERATIONS_SERVICE_KEY): Promise<OperationsIngestConfigRow | null> {
		return this.db
			.prepare('SELECT * FROM operations_ingest_configs WHERE app_id = ? AND env = ? AND service_key = ?')
			.bind(appId, environment, serviceKey)
			.first<OperationsIngestConfigRow>()
	}

	getActiveIngestConfig(
		appId: string,
		environment: string,
		serviceKey = DEFAULT_OPERATIONS_SERVICE_KEY,
	): Promise<OperationsIngestConfigRow | null> {
		return this.db
			.prepare(`SELECT * FROM operations_ingest_configs
				WHERE app_id = ? AND env = ? AND service_key = ?
					AND dsn IS NOT NULL AND ingest_project_id IS NOT NULL AND activated_revision IS NOT NULL`)
			.bind(appId, environment, serviceKey)
			.first<OperationsIngestConfigRow>()
	}

	/** A restored Operations database may have a later cursor; advance locally and send a fresh full snapshot. */
	async advancePast(remoteRevision: number): Promise<void> {
		await this.db
			.prepare(`UPDATE operations_catalog_sync SET
				desired_revision = CASE WHEN desired_revision <= ? THEN ? ELSE desired_revision END
				WHERE singleton = 1`)
			.bind(remoteRevision, remoteRevision + 1)
			.run()
	}

	async markFailed(message: string): Promise<void> {
		await this.db
			.prepare('UPDATE operations_catalog_sync SET last_error = ? WHERE singleton = 1')
			.bind(message.slice(0, 200))
			.run()
	}
}

/** Durable per-run outbox for the private Delivery → Operations release projection. */
export class OperationsReleaseRepository {
	constructor(protected readonly db: SqlDatabase, protected readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

	async project(runId: string, payloadJson: string): Promise<number> {
		const row = await firstRow<{ desired_revision: number | string }>(
			this.db
				.prepare(`INSERT INTO operations_release_sync
					(run_id, desired_revision, applied_revision, payload_json)
					VALUES (?, 1, 0, ?)
					ON CONFLICT (run_id) DO UPDATE SET
						desired_revision = operations_release_sync.desired_revision + 1,
						payload_json = excluded.payload_json
					RETURNING desired_revision`)
				.bind(runId, payloadJson),
		)
		return releaseInteger(row.desired_revision, 'desired_revision')
	}

	async listPending(limit = 100): Promise<OperationsReleaseSyncRow[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM operations_release_sync
				WHERE applied_revision < desired_revision
				ORDER BY run_id LIMIT ?`)
			.bind(limit)
			.all<OperationsReleaseSyncRow>()
		return results
	}

	async get(runId: string): Promise<OperationsReleaseSyncRow | null> {
		return this.db.prepare('SELECT * FROM operations_release_sync WHERE run_id = ?').bind(runId).first<OperationsReleaseSyncRow>()
	}

	async markAttempt(runId: string, revision: number): Promise<void> {
		await this.db
			.prepare(`UPDATE operations_release_sync SET last_attempt_at = ?
				WHERE run_id = ? AND desired_revision = ?`)
			.bind(this.now(), runId, revision)
			.run()
	}

	async markApplied(runId: string, revision: number): Promise<void> {
		await this.db
			.prepare(`UPDATE operations_release_sync SET
					applied_revision = CASE WHEN applied_revision < ? THEN ? ELSE applied_revision END,
					last_success_at = ?,
					last_error = NULL
				WHERE run_id = ?`)
			.bind(revision, revision, this.now(), runId)
			.run()
	}

	async markFailed(runId: string, message: string): Promise<void> {
		await this.db
			.prepare('UPDATE operations_release_sync SET last_error = ? WHERE run_id = ?')
			.bind(message.slice(0, 200), runId)
			.run()
	}
}

function releaseInteger(value: number | string, field: string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid operations release ${field}`)
	return parsed
}

function catalogState(row: OperationsCatalogSyncStateRow): OperationsCatalogSyncState {
	return {
		desiredRevision: catalogInteger(row.desired_revision, 'desired_revision'),
		appliedRevision: catalogInteger(row.applied_revision, 'applied_revision'),
		attemptedRevision: row.attempted_revision === null ? null : catalogInteger(row.attempted_revision, 'attempted_revision'),
		lastSnapshotHash: row.last_snapshot_hash,
		appliedSnapshotHash: row.applied_snapshot_hash,
		lastAttemptAt: row.last_attempt_at === null ? null : catalogInteger(row.last_attempt_at, 'last_attempt_at'),
		lastSuccessAt: row.last_success_at === null ? null : catalogInteger(row.last_success_at, 'last_success_at'),
		lastError: row.last_error,
	}
}

function catalogInteger(value: number | string, field: string): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid operations catalog ${field}`)
	return parsed
}

function generateIngestPublicKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	let value = ''
	for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
	return value
}

/** Control-plane persistence capabilities selected together by a runtime composition root. */
export interface ControlRepositories {
	registry: ControlRegistryRepository
	runs: RunRepository
	polling: RepoPollingRepository
	operationsCatalog: OperationsCatalogRepository
	operationsReleases: OperationsReleaseRepository
	githubConnections: GitHubConnectionStore
}

/** The portable repository bundle. A composition root may replace one complete capability. */
export function createControlRepositories(
	db: SqlDatabase,
	options: {
		now?: () => number
		replacements?: Partial<ControlRepositories>
	} = {},
): ControlRepositories {
	const now = options.now ?? (() => Math.floor(Date.now() / 1000))
	const replacements = options.replacements ?? {}
	return {
		registry: replacements.registry ?? new ControlRegistryRepository(db, now),
		runs: replacements.runs ?? new RunRepository(db, now),
		polling: replacements.polling ?? new RepoPollingRepository(db),
		operationsCatalog: replacements.operationsCatalog ?? new OperationsCatalogRepository(db, now),
		operationsReleases: replacements.operationsReleases ?? new OperationsReleaseRepository(db, now),
		githubConnections: replacements.githubConnections ?? new GitHubConnectionStore(db, now),
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

interface ZeropsSourceBindingRow {
	repo_url: string
	github_connection_id: string | null
	github_installation_id: number | null
	provider: string
	transport_kind: string | null
	app_owner: string | null
}

interface ZeropsConnectionBindingRow {
	transport_kind: string
	app_owner: string
}

function parseGitHubSourceTransportKind(value: string): GitHubSourceTransportKind {
	if (value === 'keyed-v2') return value
	throw new Error('invalid GitHub source transport kind')
}

function githubRepositoryOwner(repoUrl: string): string | null {
	const match = /^github\.com\/([^/]+)\/[^/]+$/.exec(repoUrl)
	return match?.[1] ?? null
}

export { uuidv7 }
