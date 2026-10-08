import type { AccessTokenClaims, DomainEvent, IamRpc, PermissionEntry, Scope } from '@fabrika/auth-core'
import { permits, scopedValues } from '@fabrika/auth-core'
import { readCredentials } from './request'
import type { AuthContext, ListPrincipalsFailure, PrincipalIdentity, PrincipalList } from './types'

// ── AuthContext (real) ─────────────────────────────────────────────────────────

/**
 * The real `AuthContext`. `can`/`scopedTo` are pure functions over the resolved permission array (no
 * per-check round-trip); only `audit` calls the binding. Backs BOTH a principal-bound caller (cookie
 * session / API key) and an ANONYMOUS one (a standalone share link) — the latter has
 * `principal = null`; `audit` then attributes to the credential label + token id, principal null.
 */
class RealAuthContext implements AuthContext {
	readonly ok = true

	constructor(
		private readonly binding: IamRpc,
		private readonly appId: string,
		private readonly permissions: PermissionEntry[],
		private readonly requestId: string,
		readonly principal: PrincipalIdentity | null,
		/** Audit actor label — the principal's label, or the credential label. */
		private readonly auditLabel: string,
		/** The credential id, for the audit linkage of an anonymous caller (null when bound). */
		private readonly anonymousTokenId: string | null,
	) {}

	can(action: string, scope?: Scope): boolean {
		// `permits` already encodes the scope-less rule: with no scope, ONLY global
		// (scope === null) entries satisfy.
		return permits(this.permissions, action, scope)
	}

	scopedTo(action: string, dimension: string): string[] | null {
		// `dimension` picks the scope type — scopes are flat & independent, so a value
		// list is always relative to one dimension.
		return scopedValues(this.permissions, action, dimension)
	}

	audit(event: DomainEvent): Promise<void> {
		return this.binding.audit({
			app: this.appId,
			requestId: this.requestId,
			principalId: this.principal?.id ?? null,
			principalLabel: this.auditLabel,
			...(this.anonymousTokenId === null ? {} : { credentialId: this.anonymousTokenId }),
			action: event.action,
			resourceType: event.resourceType,
			resourceId: event.resourceId,
			diff: event.diff,
			metadata: event.metadata,
		})
	}
}

/**
 * Build an `AuthContext` from a verified access token's claims — the seam every authentication path
 * uses (the proxy-injected token). The SDK has verified the token LOCALLY; this wraps its claims in the
 * same `permits`-backed context the RPC path returns,
 * so `can()` / `scopedTo()` / `audit()` behave identically. A token with no `ptype` is anonymous
 * (`principal: null`).
 */
export function buildAuthContext(binding: IamRpc, appId: string, claims: AccessTokenClaims, requestId: string): AuthContext {
	const principal: PrincipalIdentity | null = claims.ptype === undefined
		? null
		: { id: claims.sub, type: claims.ptype, label: claims.label ?? claims.sub }
	const auditLabel = claims.label ?? (principal === null ? `credential:${claims.sub}` : claims.sub)
	return new RealAuthContext(binding, appId, claims.perms, requestId, principal, auditLabel, principal === null ? claims.sub : null)
}

// ── IamClient ──────────────────────────────────────────────────────────────────

/**
 * Thin, app-facing wrapper over the IAM Worker service binding. Bakes the caller `app` id
 * into the constructor so app code can never forget or mistype it. Depends ONLY on the
 * `IamRpc` contract from `@fabrika/auth-core` — never on the Worker — which is what keeps the
 * SDK worker-independent (the binding is the deployed Worker, reached at runtime).
 */
export class IamClient {
	constructor(
		private readonly binding: IamRpc,
		private readonly appId: string,
	) {}

	/**
	 * List the app's people directory — the USER principals who can access this app. Forwards the
	 * CALLER's credential; the IAM Worker resolves the caller and scopes the roster to the
	 * verified app (you only ever see your own app's people). For an assignee picker / actor
	 * label list. Authorized for any member with a permission on the app; a zero-grant user → 403.
	 */
	async listPrincipals(req: Request): Promise<PrincipalList | ListPrincipalsFailure> {
		const { credential, requestId } = readCredentials(req)
		const result = await this.binding.listPrincipals({ app: this.appId, credential, requestId })
		if (result.ok) {
			return { ok: true, principals: result.principals }
		}
		return { ok: false, reason: result.reason, status: listPrincipalsStatus(result.reason) }
	}
}

/** missing/invalid → 401; unknown_principal/disabled/not_allowed → 403. */
function listPrincipalsStatus(reason: ListPrincipalsFailure['reason']): 401 | 403 {
	return reason === 'missing_token' || reason === 'invalid_token' ? 401 : 403
}
