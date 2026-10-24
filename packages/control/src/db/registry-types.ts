import type { AppEnvKind } from '@fabrika/control-contract'
import { z } from 'zod'

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
	/** `dev` or `standard`; set at creation and never changed (`0016_dev_environments.sql` checks it). */
	kind: AppEnvKind
	domain: string | null
	public_origin: string | null
	/**
	 * The origins this environment lists for its cross-origin endpoints (ADR-0022), a JSON array of exact origins; `[]`
	 * lists none. Read it through `appEnvCrossOrigins`.
	 */
	cross_origins_json: string
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
	/** 1 when an operator marked this environment as an MCP authoring target (ADR-0049), else 0. */
	authoring: number
	/** The run whose snapshot is this environment's active access (ADR-0050); NULL until a run publishes. */
	published_run_id: string | null
	/** That snapshot, as published (`src/approval/snapshot.ts`); NULL exactly when `published_run_id` is. */
	published_snapshot_json: string | null
	/** Advanced by every publication; a publication names the generation it read (compare-and-swap). */
	generation: number
	/** 1 when a widening waits for a human's approval here (ADR-0050), else 0. */
	protected: number
	/** Advanced by every change of `protected`; a publication names the revision it classified under. */
	protection_revision: number
	created_at: number
}

const storedCrossOrigins = z.array(z.string())

/** The environment's stored cross-origin list. Only Control writes the column, so a malformed one is a fault, not input. */
export function appEnvCrossOrigins(row: Pick<AppEnvRow, 'app_id' | 'env' | 'cross_origins_json'>): string[] {
	const parsed = storedCrossOrigins.safeParse(JSON.parse(row.cross_origins_json))
	if (!parsed.success) throw new Error(`stored cross-origin list of ${row.app_id}/${row.env} is not an array of strings`)
	return parsed.data
}

/** The list as a provider takes it (`ProviderEnvironment`, `ProviderNamespaceMember`): absent when the environment lists none. */
export function crossOriginsField(row: Pick<AppEnvRow, 'app_id' | 'env' | 'cross_origins_json'>): { readonly crossOrigins?: readonly string[] } {
	const origins = appEnvCrossOrigins(row)
	return origins.length === 0 ? {} : { crossOrigins: origins }
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
	/** The target an unconfirmed `namespaces.update` was moving to; non-NULL exactly while the row is marked. */
	update_target_json: string | null
	/** 1 when a proxy repair was requested while the row was marked; the update's clearing write replays it. */
	repair_requested: number
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
	/** Omitted keeps the stored list; a new environment starts with none. */
	crossOrigins?: readonly string[]
	triggerRef?: string | null
	/** Omitted keeps the stored flag; a new environment starts as not an authoring target. */
	authoring?: boolean
	/** Applied when the write creates the environment, `standard` when omitted; an update never changes it. */
	kind?: AppEnvKind
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

/** An app's GitHub source binding is partial, stale, or points at another owner's repository. */
export class SourceBindingError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SourceBindingError'
	}
}

/**
 * What a registry write read before it decided (ADR-0050): the environment did not exist, or existed at this
 * `generation`. The write applies only if that still holds, so a protection change, a publication or another
 * registry write in between refuses it.
 */
export type AppEnvExpectation = { readonly absent: true } | { readonly generation: number }

/** The environment is not what the write read: another change landed first. */
export class AppEnvChangedError extends Error {
	constructor(readonly appId: string, readonly env: string) {
		super(`app env ${appId}/${env} changed while the request ran`)
		this.name = 'AppEnvChangedError'
	}
}

/** Another environment of the app already deploys on this trigger ref; `idx_app_envs_trigger` holds one per app. */
export class AppEnvTriggerRefConflictError extends Error {
	constructor(readonly appId: string, readonly env: string, readonly triggerRef: string, readonly otherEnv: string) {
		super(
			`trigger ref ${triggerRef} is already used by environment ${otherEnv} of app ${appId}; each environment of an app needs its own trigger ref`,
		)
		this.name = 'AppEnvTriggerRefConflictError'
	}
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
