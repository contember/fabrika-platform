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
import type {
	AppActionDef,
	AppDelegationDef,
	AppLinkMountDef,
	AppMemberItem,
	AppSchema,
	AppScopeDef,
	Locale,
	PermissionEntry,
	PermissionSource,
	PrincipalAffiliation,
	PrincipalType,
	RoleDef,
} from '@fabrika/auth-core'

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
	/** `external`: a person from outside the organization, who holds only roles declared external (ADR-0051). */
	affiliation: PrincipalAffiliation
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
	/** The mailbox is listed in `IAM_BOOTSTRAP_ADMINS`: an internal user with it is an installation admin. */
	bootstrapMailbox: boolean
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
	/** Omitted: `internal`. An `external` user signs in by password only, and OIDC never claims it. */
	affiliation?: PrincipalAffiliation
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
	/** How the human proved who they were; `local_dev` is IAM's `LOCAL_DEV_LOGIN` bypass. */
	authenticationMethod: 'oidc' | 'password' | 'local_dev'
	/** The app this session is bound to (an ADR-0022 child); null = the IAM session itself. */
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
	/** Share-link mounts; absent when the app declares none. */
	links?: Record<string, AppLinkMountDef>
	/** Endpoints that may spend membership authority; absent when the app declares none. */
	delegations?: Record<string, AppDelegationDef>
	/** The language IAM speaks to the app's people; absent when the app declares none. */
	locale?: Locale
	/** The name IAM shows for the app; absent when the app declares none. */
	displayName?: string
	/** The actions that manage and list the app's own people; absent when the app declares none. */
	members?: { manage: string; list: string }
	/** `labels` when the app's directory shows labels to `members.list` holders. */
	directory?: 'labels'
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
	/** Absolute expiry (unix seconds). REQUIRED, and at most `MAX_KEY_LIFETIME_SECONDS` ahead: no key is permanent. */
	expiresAt: number
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
	/** A login attempt or a mint (`authenticate`), or the end of a session (`logout`). */
	kind: 'authenticate' | 'logout'
	principalId: string | null
	credentialId: string | null
	decision: 'allow' | 'deny'
	reason: string | null
	/** The login opened a session of an installation administrator. */
	privileged: boolean
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

/** Every procedure that names a principal keys it as `principalId`; a bare `id` names some other resource. */
export interface PrincipalIdInput {
	principalId: string
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
 * The public origins IAM will hand this app a session at (ADR-0022). Declarative: the whole set is
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
// ── Workload keys (Control's reconcile of jobs and webhooks) ──────────────────

/**
 * Issue a fresh key for one workload of an application (ADR-0022 "Principal kinds"). The key resolves to the actions
 * the app's reconciled schema declares for the workload. Every other key of the workload is revoked except `keep`.
 */
export interface IssueWorkloadKeyRequest {
	/** The IAM application id `<app>@<env>`. */
	app: string
	/** `app` is the connector of the application named `name`, which consumes an export of `app`. */
	kind: 'job' | 'webhook' | 'app'
	name: string
	/** Absolute expiry (unix seconds), after now and at most 30 days ahead. */
	expiresAt: number
	/**
	 * The credential id of the key the caller has recorded as active, which stays valid until the caller replaces it; null
	 * when it has none. A key issued earlier and never recorded is an orphan, and is revoked.
	 */
	keep: string | null
}

/** The plaintext key is returned once. */
export interface IssueWorkloadKeyResponse {
	key: string
	credentialId: string
	principalId: string
	expiresAt: number
}

/**
 * Revoke every key of one workload of `app`, the key a rotation kept included: what Control asks when a consumer stops
 * importing from `app`. A workload with no principal has nothing to revoke.
 */
export interface RevokeWorkloadKeysRequest {
	app: string
	kind: 'job' | 'webhook' | 'app'
	name: string
}

export interface RevokeWorkloadKeysResponse {
	revoked: number
}

// ── Membership transport keys (Control's reconcile of applications without an IAM binding) ──

/**
 * Issue a fresh membership transport key for one application environment (ADR-0022 rule 6). The key authenticates
 * IAM's `/membership/*` surface and pins the application id; it carries no authority. Every other key of the
 * application environment is deleted except `keep`.
 */
export interface IssueMembershipKeyRequest {
	/** The IAM application id `<app>@<env>`. */
	app: string
	/** Absolute expiry (unix seconds), after now and at most 30 days ahead. */
	expiresAt: number
	/** The id of the key the caller has recorded as active, which stays valid until the caller replaces it; null when it has none. */
	keep: string | null
}

/** The issued key, shown once. `id` is what a later issuance keeps. */
export interface IssueMembershipKeyResponse {
	key: string
	id: string
	expiresAt: number
}

// ── An application's own people, administered by its own administrator ───────

/**
 * An application whose people the caller administers: it holds the application's `members.manage` globally there.
 * `roles` are the application's global roles the caller may grant, those whose every action it holds itself.
 */
export interface AdministeredAppDto {
	app: string
	displayName: string | null
	roles: { key: string; name: string; permissions: string[] }[]
}

export interface AppPeopleInput {
	app: string
	/** The previous page's `next`. */
	after?: string
}

/** One page of the application's people, as its administrator sees them: labels, addresses and last sign-ins. */
export interface AppPeopleDto {
	app: string
	members: AppMemberItem[]
	next: string | null
}

/**
 * Give a person who already has an IAM principal one of the application's global roles, by its address (the people
 * list answers each person's). An address IAM knows no person for is a 404: an IAM administrator invites people, an
 * application's administrator does not. Holding the role already answers the same.
 */
export interface GrantAppRoleRequest {
	app: string
	role: string
	email: string
}

export interface GrantAppRoleResponse {
	principalId: string
	role: string
	/** False when the person held the role already. */
	granted: boolean
}

/** Remove the global grant of `role` from a person. Repeating it answers the same. */
export interface RevokeAppRoleRequest {
	app: string
	role: string
	principalId: string
}

export interface RevokeAppRoleResponse {
	/** False when the person held no such grant. */
	revoked: boolean
}

export interface IamAdminRpcContract {
	me: RpcProcedure<void, MeDto>
	principals: {
		list: RpcProcedure<ListPrincipalsInput, CursorList<PrincipalListItem>>
		get: RpcProcedure<PrincipalIdInput, PrincipalDetail>
		invite: RpcProcedure<InviteRequest, PrincipalListItem>
		update: RpcProcedure<UpdatePrincipalInput, PrincipalListItem>
		/**
		 * Make an external user internal, revoking its sessions and pending password actions. A bootstrap mailbox becomes
		 * an installation admin. There is no way back; promoting an internal principal is a 409.
		 */
		promote: RpcProcedure<PrincipalIdInput, PrincipalListItem>
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
		/** A role grant the principal already holds — same role, scope and app — answers 409 naming it. */
		create: RpcProcedure<CreateGrantRequest, GrantDto>
		delete: RpcProcedure<GrantIdInput, OkResponse>
	}
	apps: {
		list: RpcProcedure<void, ListResponse<AppDto>>
		getSchema: RpcProcedure<AppInput, AppSchemaDto>
		setReturnOrigins: RpcProcedure<SetReturnOriginsRequest, ReturnOriginsDto>
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
	workloads: {
		issueKey: RpcProcedure<IssueWorkloadKeyRequest, IssueWorkloadKeyResponse>
		revokeKeys: RpcProcedure<RevokeWorkloadKeysRequest, RevokeWorkloadKeysResponse>
	}
	membershipKeys: {
		issue: RpcProcedure<IssueMembershipKeyRequest, IssueMembershipKeyResponse>
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
	/**
	 * An application's own people, administered by whoever holds the application's `members.manage` globally there: no
	 * installation admin needed. Each change writes its audit row under the application.
	 */
	appPeople: {
		apps: RpcProcedure<void, ListResponse<AdministeredAppDto>>
		list: RpcProcedure<AppPeopleInput, AppPeopleDto>
		grant: RpcProcedure<GrantAppRoleRequest, GrantAppRoleResponse>
		revoke: RpcProcedure<RevokeAppRoleRequest, RevokeAppRoleResponse>
	}
}

export type { AppActionDef, AppMemberItem, AppSchema, AppScopeDef, PermissionEntry, PermissionSource, PrincipalAffiliation, PrincipalType, RoleDef }
export * from './oauth'
