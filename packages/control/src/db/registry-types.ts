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
	/**
	 * A `vault:` ref, or the provider's own ref for a provider-managed secret. A row from before secrets were
	 * vault-only may hold anything, including plaintext, so it is never echoed (`toAppSecretDto`).
	 */
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
