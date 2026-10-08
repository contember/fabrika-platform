export type PrincipalType = 'user' | 'service'

/**
 * Where a resolved permission entry came from. Used for debuggability in the admin UI
 * ("why does this user have this permission?"); `can()`/`scopedTo()` ignore it.
 *  - 'grant'             — explicit `grants` row
 *  - 'bootstrap'         — IAM_BOOTSTRAP_ADMINS env match (resolution-time only)
 *  - `group:${groupRef}` — IdP group → role mapping (the `<org>/<team>` ref)
 */
export type PermissionSource = 'grant' | 'bootstrap' | `group:${string}`

/**
 * A flat, app-owned scope coordinate — one dimension (`type`) and an opaque value.
 * Dimensions are INDEPENDENT: there is NO hierarchy/containment between them.
 * `value` is an opaque app-owned string; core never validates it.
 */
export interface Scope {
	type: string
	value: string
}

export interface PermissionEntry {
	action: string
	/** null = global / all scopes */
	scope: Scope | null
	source: PermissionSource
}

/**
 * Domain event apps emit. Only the app knows what changed.
 *
 * IMPORTANT: `diff`/`metadata` may carry sensitive values (settings can hold secrets).
 * The app MUST redact secret material before passing them — audit storage is verbatim
 * and long-lived; the IAM Worker stores what it receives as-is.
 */
export interface DomainEvent {
	action: string
	resourceType: string
	resourceId?: string
	diff?: unknown
	metadata?: unknown
}

export interface RoleDef {
	name: string
	description?: string
	permissions: string[]
	/**
	 * A membership role is granted only in a value of `scope`, never globally. `assignableBy` names the
	 * membership roles of the same scope whose holders may assign it there; absent, only an IAM
	 * administrator assigns it.
	 */
	member?: { scope: string; assignableBy?: string[] }
}

/**
 * One scope dimension an app exposes. IAM evaluates every value as a flat scope; `in` only tells IAM
 * which dimension a share link's containment chain names next.
 */
export interface AppScopeDef {
	type: string
	label?: string
	/** The dimension that contains every value of this one (`note` is in `workspace`). */
	in?: string
	/** The membership role IAM grants the caller in a value it creates for them (`createScope`). */
	creator?: string
	/** The action that manages the members of a value, and the one that lists them. */
	members?: { manage: string; list: string }
}

/** One action in an app's catalog (used for validation + admin UI discovery). */
export interface AppActionDef {
	action: string
	description?: string
}

/** A share-link mount: what a link key of the mount carries and who may issue one. */
export interface AppLinkMountDef {
	/** The dimension of the object a link is bound to. */
	dimension: string
	/** Exact actions frozen into every key, on the bound object. */
	grants: string[]
	/** The action the issuer must hold on the object or a value containing it. */
	issuedBy: string
	/** The longest a link of the mount may live, in days. */
	maxDays: number
}

/**
 * An endpoint whose request may spend the caller's membership authority. IAM issues a delegation grant
 * only for one of these: `members` for an endpoint whose action is the dimension's `members.manage`,
 * `creates` for one that creates a value of the dimension.
 */
export interface AppDelegationDef {
	action: string
	dimension: string
	purpose: 'members' | 'creates'
}

/** An app's full authz vocabulary, declared in the app's code, reconciled into Propustka. */
export interface AppSchema {
	scopes: AppScopeDef[]
	actions: AppActionDef[]
	/** role_key -> def; these are origin='app' roles. */
	roles: Record<string, RoleDef>
	/** Compiled from a contract (`schemaFromContract`): IAM then refuses every wildcard action written for the app. */
	contract?: boolean
	/** Link mount id -> its definition. Removing a mount revokes its keys. */
	links?: Record<string, AppLinkMountDef>
	/** Endpoint id -> what the endpoint may spend through a delegation grant. */
	delegations?: Record<string, AppDelegationDef>
}

// ── Per-path access gates (the propustka-native front door, enforced by the proxy) ──
//
// Replaces the deleted Cloudflare-Access edge model (AppAccess/AccessAppDecl/AccessRule). There is
// no IAM reconcile for these: gate rules are deployed verbatim in the proxy manifest, and the proxy
// decides WHICH credential KIND a path requires. Three kinds mirror the three old edge decisions:
//   - public  → no credential (the old `bypass`/everyone carve-out)
//   - service → a machine `px_` key (the old `non_identity`/service-token gate)
//   - human   → a logged-in human via `px_session`/`px_token` (the old `allow`-by-audience gate)
// WHO is an admitted human stays centrally owned by propustka (decided at `/auth/callback`, the
// admission allowlist), exactly as the old central edge audience did — a `human` gate only asserts
// "a resolved user principal exists". Auth-surface paths (`/auth/*`, `/.well-known/jwks.json`) live
// on PROPUSTKA's host, not the app's, so apps never declare them.

/** Where a propustka `px_` credential rides on a request. */
export interface CredentialLocation {
	/** Transport carrying the credential. */
	in: 'header' | 'query' | 'cookie'
	/** Header / query-param / cookie name. A header value may be bare or `Bearer <token>`. */
	name: string
}

/** What a matched path requires. The discriminant `kind` mirrors the three old edge decisions. */
export type GateKind =
	/** Anyone — no credential. Terminal; resolves to an ANONYMOUS AuthContext (`principal: null`). */
	| { kind: 'public' }
	/**
	 * A machine `px_` key — a bearer (default `Authorization: Bearer`) or the
	 * declared `credential` location. ABSENT → falls through to the next matching rule; PRESENT but
	 * invalid → fail closed (no fall-through).
	 */
	| { kind: 'service'; credential?: CredentialLocation }
	/** A logged-in human (a `user` principal via the `px_session`/`px_token` cookies). */
	| { kind: 'human' }
	/**
	 * An OAuth bearer access token minted for `resource` (RFC 8707) that carries every scope in
	 * `scopes`. Missing or invalid → 401 with an RFC 9728 `WWW-Authenticate` challenge; never a
	 * browser login redirect. Terminal like `public`: an absent token does not fall through.
	 */
	| { kind: 'oauth'; resource: string; scopes: string[] }

/**
 * One per-path gate rule. The array order on `AppGates.rules` is the PRECEDENCE: the first rule whose
 * `path` matches AND whose required credential is present is enforced. A matching rule whose credential
 * is ABSENT falls through to the next matching rule; a request matching NO rule is denied (fail-closed).
 * `path` is a glob where `*` matches any run of chars (e.g. `/api/v1/*`) and a whole `:name` segment
 * matches exactly one non-empty segment (e.g. `/files/:id`); anchored.
 */
export type GateRule = { path: string } & GateKind

/** An app's full per-path gate declaration, enforced by the Fabrika proxy. */
export interface AppGates {
	rules: GateRule[]
}

/**
 * App-aware role lookup. The worker layers a built-in cross-app source (admin) over a
 * per-app DB source. `app` is the calling app id; null = cross-app/built-in only.
 */
export interface RoleSource {
	getRole(app: string | null, key: string): RoleDef | undefined
	listRoles(app: string | null): Record<string, RoleDef>
}
