import type { DomainEvent, PrincipalListItem, PrincipalType, Scope } from '@fabrika/auth-core'

/**
 * The resolved caller's identity — who Access says you are, as the IAM Worker recorded
 * the principal. Exposed on `AuthContext` so apps can stamp domain rows (created_by,
 * activity actor, assignee) and render "signed in as …" without a second lookup. It is
 * NOT a permission surface — authorization is still `can()` / `scopedTo()`.
 *  - `id`    — the IAM principal id (UUIDv7); stable, safe to store on domain rows.
 *  - `type`  — 'user' (a human identity) or 'service' (a machine principal / API key).
 *  - `label` — human-readable: the user's email, or the service principal's name.
 */
export interface PrincipalIdentity {
	readonly id: string
	readonly type: PrincipalType
	readonly label: string
}

// ── Result surfaces ──────────────────────────────────────────────────────────
//
// Every method returns a discriminated union whose members all carry an `ok` field,
// so app code branches once on `result.ok`. The ok:true members are the rich
// `AuthContext` / `PrincipalList` surfaces; the ok:false members are
// the typed failures below, each carrying the HTTP status the app should return.
//
// The ok:true surfaces are modelled as *interfaces* (not concrete classes) so that both
// the real (`permits`-backed) and fake (allow-all-except-deny) implementations satisfy a
// single shared shape without any casts — see the design note in the package README of the
// spec. The documented surface (`ok` / `can` / `scopedTo` / `audit`) is the interface.

/**
 * The authenticated, ok:true result. `can`/`scopedTo` are local & pure (no binding call);
 * only `audit` reaches the IAM Worker.
 */
export interface AuthContext {
	readonly ok: true
	/**
	 * The resolved caller identity (id / type / label), or `null` for an ANONYMOUS credential — a
	 * standalone (no-principal) share link. For stamping domain rows and
	 * display — NOT a permission surface (authorization stays `can` / `scopedTo`, which work the same
	 * either way). Stamp `created_by` with `principal?.id ?? null`.
	 */
	readonly principal: PrincipalIdentity | null
	/**
	 * Point check: may this principal do `action` (optionally within `scope`, an opaque
	 * `{ type, value }` coordinate)? Scope-less → satisfied by GLOBAL permissions only; a
	 * scoped grant never widens into a scope-less allow.
	 */
	can(action: string, scope?: Scope): boolean
	/**
	 * Scoping: which scope values may this principal perform `action` on within `dimension`
	 * (a scope type, e.g. `'organization'`)? Scopes are flat & independent — a list is always
	 * relative to one dimension.
	 *  - `null`      → unrestricted (holds the action globally — e.g. an admin)
	 *  - `[]`        → no access within this dimension at all
	 *  - non-empty   → exactly those (opaque, app-owned) scope values
	 * Consume via `applyScope` so the empty-`IN ()` trap is handled once. `dimension` is
	 * REQUIRED — multiple scope types may coexist, so the caller must say which one.
	 */
	scopedTo(action: string, dimension: string): string[] | null
	/** Emit a domain audit event; app/principal/requestId are auto-attached. Fire-and-forget. */
	audit(event: DomainEvent): Promise<void>
}

/** Successful `listPrincipals` — the app's people directory (user principals). */
export interface PrincipalList {
	readonly ok: true
	principals: PrincipalListItem[]
}

// ── Failures ─────────────────────────────────────────────────────────────────

/** `listPrincipals` failure. missing/invalid → 401; unknown_principal/disabled/not_allowed → 403. */
export interface ListPrincipalsFailure {
	readonly ok: false
	reason: 'missing_token' | 'invalid_token' | 'unknown_principal' | 'disabled' | 'not_allowed'
	status: 401 | 403
}
