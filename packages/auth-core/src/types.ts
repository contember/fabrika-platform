export type PrincipalType = 'user' | 'service'

/**
 * The principal kind of a workload credential (ADR-0022 "Principal kinds"): a contract job, a webhook, or the connector
 * of a consuming application. IAM stores a workload principal as a `service` row and mints its key with this kind, so
 * a workload key is never a `machine` caller.
 */
export type WorkloadKind = 'job' | 'webhook' | 'app'

export const WORKLOAD_KINDS: readonly WorkloadKind[] = ['job', 'webhook', 'app']

/** The principal kind a token carries in `ptype`: a stored principal type, or a workload kind. */
export type TokenPrincipalType = PrincipalType | WorkloadKind

export function isWorkloadKind(value: unknown): value is WorkloadKind {
	return value === 'job' || value === 'webhook' || value === 'app'
}

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

/**
 * The role keys IAM defines itself for every app. A built-in wins over an app role of the same key at
 * resolution, so a membership role, and any role of a contract application, may not use one.
 */
const BUILTIN_ROLE_KEY_LITERALS = ['admin'] as const

/** A role key IAM defines itself, as a type: `defineVocabulary` refuses a role of that name. */
export type BuiltinRoleKey = (typeof BUILTIN_ROLE_KEY_LITERALS)[number]

export const BUILTIN_ROLE_KEYS: readonly string[] = BUILTIN_ROLE_KEY_LITERALS

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
	/**
	 * The workloads of a contract application and their exact actions. A workload key resolves to these actions, app-wide,
	 * and to nothing once its workload is no longer declared; removing one revokes its keys.
	 */
	workloads?: AppWorkloadDef[]
}

/**
 * A job or a webhook of a contract application, or a consuming application of its exports (`app`, named by that
 * application's id): the actions its credential carries.
 */
export interface AppWorkloadDef {
	kind: WorkloadKind
	name: string
	actions: string[]
}

/**
 * App-aware role lookup. The worker layers a built-in cross-app source (admin) over a
 * per-app DB source. `app` is the calling app id; null = cross-app/built-in only.
 */
export interface RoleSource {
	getRole(app: string | null, key: string): RoleDef | undefined
	listRoles(app: string | null): Record<string, RoleDef>
}
