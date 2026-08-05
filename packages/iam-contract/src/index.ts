// @fabrika/iam-contract — the runtime-neutral IAM administration contract.
//
// `IamAdminRpcContract` at the bottom is the WHOLE administration API: one transport, so policy,
// audit and hidden-object behaviour cannot diverge between two of them. What remains of `/admin/*`
// REST is machine provisioning — an app's schema reconcile (`PutAppSchemaRequest`) and the
// first-machine-caller bootstrap (`ProvisionApiKeyRequest`) — and it shares these same shapes.
//
// Shared by @fabrika/iam and its browser clients. Reuses @fabrika/auth-core types
// where they fit. Keep these clean and complete: they are the admin API contract.

import type { RpcProcedureContract } from '@fabrika/app'
import type { AppActionDef, AppSchema, AppScopeDef, PermissionEntry, PermissionSource, PrincipalType, RoleDef } from '@fabrika/auth-core'

// ── Common wrappers ───────────────────────────────────────────────────────────

/** A plain list response. */
export interface ListResponse<T> {
	items: T[]
}

/**
 * A cursor-paginated list. `nextCursor` is the opaque cursor to pass as `before`
 * for the next page; null when there are no more rows.
 */
export interface CursorList<T> {
	items: T[]
	nextCursor: string | null
}

// ── Principals ────────────────────────────────────────────────────────────────

/** Derived principal status — invited (unclaimed) → active → disabled. */
export type PrincipalStatus = 'invited' | 'active' | 'disabled'

export interface PrincipalListItem {
	id: string
	type: PrincipalType
	label: string
	email: string | null
	externalId: string | null
	status: PrincipalStatus
	createdAt: number
}

export interface GrantDto {
	id: string
	principalId: string
	/** Named role/policy key; null for an inline grant (then `permissions` is set). */
	roleKey: string | null
	/** Inline action-pattern set; null for a role-based grant (then `roleKey` is set). */
	permissions: string[] | null
	/** Scope dimension; null = global (both rise/fall together). */
	scopeType: string | null
	/** Opaque, app-owned scope value; null = global. */
	scopeValue: string | null
	/** App id this grant applies to; null = all apps (cross-app). */
	app: string | null
	grantedBy: string | null
	expiresAt: number | null
	createdAt: number
	/** True when `roleKey` is set but no longer resolves to a known role (zero perms). */
	dangling: boolean
}

export interface PrincipalDetail extends PrincipalListItem {
	grants: GrantDto[]
	/** Effective permissions with `source` (grant / bootstrap / group:<ref>). */
	permissions: PermissionEntry[]
	authentication: {
		/** OIDC is linked when this user has claimed an identity-provider subject. */
		oidc: { state: 'unavailable' | 'unlinked' | 'linked' }
		/** Password access is globally opt-in and then enabled per user. */
		password: { state: 'unavailable' | 'disabled' | 'pending' | 'enabled' }
	}
}

export interface InviteRequest {
	email: string
}

export interface UpdatePrincipalRequest {
	disabled: boolean
}

// ── Sessions ──────────────────────────────────────────────────────────────────

/**
 * A browser session, as an operator sees it. Never the cookie or its hash — a session is addressed
 * by `id`, which is not a credential.
 */
export interface SessionDto {
	id: string
	principalId: string
	/** How the human proved who they were when this session was created. */
	authenticationMethod: 'oidc' | 'password'
	/** The app this session is bound to (an ADR-0021 child); null = the IAM session itself. */
	app: string | null
	/** The IAM session this was derived from; null on an IAM session. Revoking that one revokes this. */
	parentSessionId: string | null
	/** `active` until it is revoked or its expiry passes. A revoked session reads `revoked`. */
	status: 'active' | 'revoked' | 'expired'
	createdAt: number
	expiresAt: number
	revokedAt: number | null
}

// ── Grants ────────────────────────────────────────────────────────────────────

export interface CreateGrantRequest {
	principalId: string
	/** A named role/policy key — XOR `permissions` (supply exactly one). */
	roleKey?: string
	/** An inline action-pattern set — XOR `roleKey` (supply exactly one). */
	permissions?: string[]
	/** Scope dimension; null / omitted = global. Both-or-neither with `scopeValue`. */
	scopeType?: string | null
	/** Opaque, app-owned scope value; null / omitted = global. */
	scopeValue?: string | null
	/** App id (a registered app id); null / omitted = all apps (cross-app). */
	app?: string | null
	expiresAt?: number | null
}

// ── Apps (read-only; the live registry derived from the schema tables) ────────

/** The set of app ids propustka knows about — the choices for a grant's `app`. */
export interface AppDto {
	id: string
}

// ── Roles & policies (per-app, DB-backed) ─────────────────────────────────────

/** A role available for the calling app — a built-in or a DB row (app/custom). */
export interface RoleDto {
	key: string
	name: string
	description?: string
	permissions: string[]
	/** 'builtin' (cross-app, e.g. admin), 'app' (reconciled), or 'custom' (admin-made). */
	origin: 'builtin' | 'app' | 'custom'
}

// ── App schema (reconciled vocabulary) ────────────────────────────────────────

/**
 * The body of `PUT /admin/apps/:app/schema` — one of the two surviving REST operations, because a
 * deploy step reconciles an app's vocabulary from outside the installation. It IS the core
 * `AppSchema`; `reconcileSchema` in `@fabrika/auth` sends exactly this.
 */
export type PutAppSchemaRequest = AppSchema

/** GET schema response — the app's scopes, actions, and origin='app' roles. */
export interface AppSchemaDto {
	app: string
	scopes: AppScopeDef[]
	actions: AppActionDef[]
	/** role_key -> def, origin='app' only (reconciled from code). */
	roles: Record<string, RoleDef>
}

// ── Policies (origin='custom' roles, admin-composed) ──────────────────────────

/** A custom policy (an origin='custom' role row) for an app. */
export interface PolicyDto {
	app: string
	key: string
	name: string
	description?: string
	permissions: string[]
	createdAt: number
}

export interface CreatePolicyRequest {
	key: string
	name: string
	description?: string
	permissions: string[]
}

export interface UpdatePolicyRequest {
	name: string
	description?: string
	permissions: string[]
}

// ── API keys (native service credentials) ─────────────────────────────────────

/** Metadata view of a service-principal API key (the secret is never returned here). */
export interface ApiKeyDto {
	principalId: string
	label: string
	status: PrincipalStatus
	grants: GrantDto[]
	createdAt: number
}

export interface ProvisionApiKeyRequest {
	label: string
	type: 'service'
	/** A named role/policy key — XOR `permissions` (supply exactly one). */
	roleKey?: string
	/** An inline action-pattern set — XOR `roleKey` (supply exactly one). */
	permissions?: string[]
	/** Scope dimension; null / omitted = global. Both-or-neither with `scopeValue`. */
	scopeType?: string | null
	/** Opaque, app-owned scope value; null / omitted = global. */
	scopeValue?: string | null
	/** App id (a registered app id); null / omitted = all apps. */
	app?: string | null
	expiresAt?: number | null
}

/**
 * Provisioning result. `apiKey` (a `px_…` credential bound to the new service principal) is shown
 * exactly ONCE — copy it now, it is not retrievable later. Carried as a bearer (or a declared
 * header) directly to apps on the propustka-native path (`mintFromKey`), no Cloudflare Access in
 * front.
 */
export interface ProvisionApiKeyResponse {
	principalId: string
	apiKey: string
}

/** Rotation result — new key shown once; principal + grants unchanged, old key stops working. */
export interface RotateApiKeyResponse {
	principalId: string
	apiKey: string
}

// ── Share links (anonymous credentials) ─────────────────────────────────────────

/** Metadata only — never the token hash or plaintext. A share link is an anonymous credential. */
export interface ShareLinkListItem {
	id: string
	label: string | null
	/** The app this link mints for. Never null on a link issued after the app binding (SEC-2). */
	app: string | null
	issuedBy: string | null
	expiresAt: number | null
	revokedAt: number | null
	createdAt: number
	/** Frozen inline grants — matched by `permits` (action + optional scope), not exact resource. */
	grants: { action: string; scope: { type: string; value: string } | null }[]
}

export interface IssueShareLinkRequest {
	/**
	 * The app the link mints for. REQUIRED: an anonymous credential's grants are frozen at issue, so
	 * the app they were delegated against is the only thing that keeps them from being spent at every
	 * other app behind the proxy.
	 */
	app: string
	/** Each grant is delegation-checked against the issuer on its `scope` (omitted → global). */
	grants: { action: string; scope?: { type: string; value: string } | null }[]
	label?: string
	expiresAt?: number
}

/** Issued share-link result — the plaintext `px_` token returned ONCE. */
export interface IssuedShareLinkResponse {
	id: string
	token: string
}

// ── Audit & auth log ──────────────────────────────────────────────────────────

export interface AuditEventDto {
	id: string
	requestId: string
	principalId: string | null
	principalLabel: string
	credentialId: string | null
	app: string
	action: string
	resourceType: string
	resourceId: string | null
	diff: unknown
	metadata: unknown
	createdAt: number
}

export interface AuthLogDto {
	id: number
	requestId: string
	app: string
	kind: 'authenticate'
	principalId: string | null
	credentialId: string | null
	decision: 'allow' | 'deny'
	reason: string | null
	createdAt: number
}

// ── Me ────────────────────────────────────────────────────────────────────────

export interface MeDto {
	id: string
	type: PrincipalType
	label: string
	permissions: PermissionEntry[]
}

// ── Typed admin RPC ──────────────────────────────────────────────────────────

export interface OkResponse {
	ok: true
}

/** Every admin list takes the same page coordinates: an opaque `before` cursor and a row `limit`. */
export interface PageInput {
	before?: string
	limit?: number
}

export interface ListPrincipalsInput extends PageInput {
	type?: PrincipalType
	status?: PrincipalStatus
	q?: string
}

export type ListApiKeysInput = PageInput

export interface ListShareLinksInput extends PageInput {
	/** Only links minting for this app. */
	app?: string
	/** Revoked links are hidden by default; the console asks for them explicitly. */
	includeRevoked?: boolean
}

export interface RotateApiKeyInput extends ApiKeyIdInput {
	/**
	 * New absolute expiry (unix seconds), or `null` for none. OMITTED carries the replaced
	 * credential's expiry forward — rotation replaces a secret, it does not extend a lifetime.
	 */
	expiresAt?: number | null
}

export interface PrincipalIdInput {
	id: string
}

export interface ListSessionsInput extends PageInput {
	/** Whose sessions to list. */
	principalId: string
}

export interface SessionIdInput {
	id: string
}

/** How many rows the call actually revoked; an already-revoked session is not counted again. */
export interface RevokedSessionsResponse {
	revoked: number
}

export interface UpdatePrincipalInput extends UpdatePrincipalRequest, PrincipalIdInput {}

/** Password action sent by email, or a one-time URL shown only in this response. */
export type PasswordActionDelivery =
	| { delivery: 'email'; email: string; expiresAt: number }
	| { delivery: 'manual'; url: string; expiresAt: number }

export interface GrantIdInput {
	id: string
}

export interface AppInput {
	app: string
}

/**
 * The public origins IAM will hand this app a session at (ADR-0021). Declarative: the whole set is
 * stated, so removing one is the same call as adding one and a stale entry cannot survive a deploy.
 */
export interface SetReturnOriginsRequest {
	app: string
	origins: string[]
}

export interface ReturnOriginsDto {
	app: string
	/** Canonicalized: lower-cased scheme and host, default port dropped, no path. */
	origins: string[]
}

export interface ListRolesInput {
	app?: string | null
}

export interface CreatePolicyInput {
	app: string
	policy: CreatePolicyRequest
}

export interface UpdatePolicyInput {
	app: string
	key: string
	policy: UpdatePolicyRequest
}

export interface PolicyIdInput {
	app: string
	key: string
}

export interface ApiKeyIdInput {
	principalId: string
}

export interface ShareLinkIdInput {
	id: string
}

export interface ListAuditInput {
	resourceType?: string
	resourceId?: string
	principalId?: string
	action?: string
	requestId?: string
	before?: string
	limit?: number
}

export interface ListAuthLogInput {
	principalId?: string
	requestId?: string
	decision?: 'allow' | 'deny'
	before?: string
	limit?: number
}

type RpcProcedure<TInput, TOutput> = RpcProcedureContract<TInput, TOutput>

/** Browser-safe typed contract for the IAM administration API. */
export interface IamAdminRpcContract {
	me: RpcProcedure<void, MeDto>
	principals: {
		list: RpcProcedure<ListPrincipalsInput, CursorList<PrincipalListItem>>
		get: RpcProcedure<PrincipalIdInput, PrincipalDetail>
		invite: RpcProcedure<InviteRequest, PrincipalListItem>
		update: RpcProcedure<UpdatePrincipalInput, PrincipalListItem>
		/** Cancel an unclaimed invite, or disable a claimed principal. */
		delete: RpcProcedure<PrincipalIdInput, OkResponse>
	}
	/**
	 * Sessions an operator no longer trusts. Revoking an IAM session also ends every app session
	 * derived from it — a child is only valid while its parent is — so this is one call, not a sweep.
	 */
	sessions: {
		list: RpcProcedure<ListSessionsInput, CursorList<SessionDto>>
		revoke: RpcProcedure<SessionIdInput, RevokedSessionsResponse>
		revokeAll: RpcProcedure<PrincipalIdInput, RevokedSessionsResponse>
	}
	passwords: {
		issueEnrollment: RpcProcedure<PrincipalIdInput, PasswordActionDelivery>
		issueReset: RpcProcedure<PrincipalIdInput, PasswordActionDelivery>
		disable: RpcProcedure<PrincipalIdInput, OkResponse>
	}
	grants: {
		create: RpcProcedure<CreateGrantRequest, GrantDto>
		delete: RpcProcedure<GrantIdInput, OkResponse>
	}
	apps: {
		list: RpcProcedure<void, ListResponse<AppDto>>
		getSchema: RpcProcedure<AppInput, AppSchemaDto>
		getReturnOrigins: RpcProcedure<AppInput, ReturnOriginsDto>
		setReturnOrigins: RpcProcedure<SetReturnOriginsRequest, ReturnOriginsDto>
		clearReturnOrigins: RpcProcedure<AppInput, ReturnOriginsDto>
	}
	roles: {
		list: RpcProcedure<ListRolesInput, ListResponse<RoleDto>>
	}
	policies: {
		list: RpcProcedure<AppInput, ListResponse<PolicyDto>>
		create: RpcProcedure<CreatePolicyInput, PolicyDto>
		update: RpcProcedure<UpdatePolicyInput, PolicyDto>
		delete: RpcProcedure<PolicyIdInput, OkResponse>
	}
	apiKeys: {
		list: RpcProcedure<ListApiKeysInput, CursorList<ApiKeyDto>>
		provision: RpcProcedure<ProvisionApiKeyRequest, ProvisionApiKeyResponse>
		rotate: RpcProcedure<RotateApiKeyInput, RotateApiKeyResponse>
		revoke: RpcProcedure<ApiKeyIdInput, OkResponse>
	}
	shareLinks: {
		list: RpcProcedure<ListShareLinksInput, CursorList<ShareLinkListItem>>
		issue: RpcProcedure<IssueShareLinkRequest, IssuedShareLinkResponse>
		revoke: RpcProcedure<ShareLinkIdInput, OkResponse>
	}
	audit: {
		list: RpcProcedure<ListAuditInput, CursorList<AuditEventDto>>
		listAuthLog: RpcProcedure<ListAuthLogInput, CursorList<AuthLogDto>>
	}
}

export type { AppActionDef, AppSchema, AppScopeDef, PermissionEntry, PermissionSource, PrincipalType, RoleDef }
