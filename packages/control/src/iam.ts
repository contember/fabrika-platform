/**
 * IAM authentication + runtime ACL helpers for the control plane.
 *
 * Each credentialed row of the console's service table resolves its caller ONCE — from the token the
 * proxy injected, verified locally against IAM's JWKS — and hands the resulting `AuthContext` to its
 * handler. The API router only performs action and scope checks against that context. The GitHub
 * webhook is a `protocol` row and authenticates by its HMAC instead.
 *
 * Nothing here enforces access: since ADR-0022 the proxy is the only enforcement point, and it has
 * already refused (or bounced to login) anything the console's table (`fabrika.service.ts`) does not admit.
 */
import {
	type AuthContext,
	type AuthFailure,
	createIam as createAppIam,
	type DomainEvent,
	type IamRpc,
	type PrincipalIdentity,
	type Scope,
} from '@fabrika/auth'
import { parseJsonStringArray } from '@fabrika/auth-core'
import { SCOPES, VOZKA_APP_ID } from './actions'
import { error } from './http'

/** The bindings + vars the IAM factory needs (a subset of the Worker `Env`). */
export interface IamEnv {
	IAM?: IamRpc
	/** IAM's origin — the issuer every token is verified against. */
	FABRIKA_IAM_ISSUER?: string
	/**
	 * JSON array of bootstrap-admin emails (normally `'[]'`). A caller whose verified email is listed
	 * here is authorized as admin (`can` → true for every action) even when IAM denies — the
	 * escape hatch for the first operator before IAM knows about fabrika.
	 */
	FABRIKA_CONTROL_BOOTSTRAP_ADMINS?: string
	/** The control plane's own public domain (see `controlPublicOrigin`). */
	FABRIKA_CONTROL_DOMAIN?: string
}

/**
 * The console's own public origin, from `FABRIKA_CONTROL_DOMAIN`.
 *
 * That variable has no settled shape and never needed one, because its only consumer read it for
 * truthiness: the local stack sets a full origin (`http://control.fabrika.localhost:18080`) and a
 * live installation a bare host (`proxy-…zerops.app`). Absolute URLs built from it (the GitHub App
 * manifest's callback, the MCP resource) need both spellings to mean the same thing — a bare host is
 * assumed `https`, which is the only scheme a public host is served on.
 *
 * Returns `undefined` when nothing usable is configured; a caller that needs an origin then fails closed.
 */
export function controlPublicOrigin(env: Pick<IamEnv, 'FABRIKA_CONTROL_DOMAIN'>): string | undefined {
	const raw = env.FABRIKA_CONTROL_DOMAIN?.trim() ?? ''
	if (raw === '') {
		return undefined
	}
	try {
		return new URL(raw.includes('://') ? raw : `https://${raw}`).origin
	} catch {
		return undefined
	}
}

/**
 * Parse the `FABRIKA_CONTROL_BOOTSTRAP_ADMINS` JSON array into a set of emails. Mirrors IAM's
 * `parseBootstrapAdmins` semantics: a malformed / non-array value fails CLOSED (empty set), so a bad
 * env var grants nobody admin. An empty / unset value (the steady state) yields an empty set.
 */
export function parseBootstrapAdmins(raw: string | undefined): ReadonlySet<string> {
	if (raw === undefined || raw.trim() === '') {
		return new Set()
	}
	return new Set(parseJsonStringArray(raw))
}

/**
 * The console's auth front door, called by each credentialed row's handler: resolve the caller through the
 * public IAM SDK (the proxy-injected token, verified locally), then apply the one control-only bootstrap hatch.
 *
 * There is ONE code path, locally included. The SDK used to carry a `DEV` persona roster that stood
 * in for IAM without verifying anything; it is gone. Locally the console is fronted by the real proxy
 * and IAM signs the operator in through its own `LOCAL_DEV_LOGIN`, so this Worker sees the same
 * injected token it sees in production.
 *
 * There used to be a second hatch here — a request bearing `FABRIKA_IAM_PROVISIONING_KEY` was
 * authorized as a synthetic global admin. It was DEAD CODE behind the proxy and could not be
 * revived: `/api/rpc` is a credentialed row, the proxy resolves a `px_` bearer by asking IAM to mint from
 * it, and the provisioning key has no `credentials` row — IAM resolves it specially, in
 * `resolveCaller`, for its OWN `/admin/*` surface. So `mintFromKey` answered `invalid_key` and the
 * request was refused before control ever saw the bearer. One mechanism per job: machine access to
 * the control plane is an IAM-ISSUED SERVICE KEY, which is a real credential the proxy can exchange,
 * and which an operator obtains with the provisioning key over IAM's admin surface. See
 * `docs/reference/human-authentication.md`.
 */
export function controlAuthenticator(env: IamEnv): (request: Request) => Promise<ControlAuthentication> {
	const iam = createAppIam(env, { appId: VOZKA_APP_ID })
	const bootstrapAdmins = parseBootstrapAdmins(env.FABRIKA_CONTROL_BOOTSTRAP_ADMINS)

	return async (request) => {
		const path = new URL(request.url).pathname
		const result = await iam.authenticate(request)
		if (!result.ok) {
			return { ok: false, response: authFailureResponse(path, result) }
		}
		const principal = result.context.principal
		const auth = principal !== null && principal.type === 'user' && bootstrapAdmins.has(principal.label)
			? new BootstrapAdminAuthContext(result.context)
			: result.context
		return { ok: true, auth }
	}
}

/** The caller of a credentialed console row, or the flat refusal its handler answers instead. */
export type ControlAuthentication = { readonly ok: true; readonly auth: AuthContext } | { readonly ok: false; readonly response: Response }

/**
 * Map an unresolved caller to a response. There is no login bounce here by design: behind the proxy an
 * unauthenticated browser is 302'd before it reaches this Worker, so a miss on `/api/*` is a flat
 * status. (`iam-admin.ts` / `operations-gateway.ts` still attach a `loginUrl` — that one comes from an
 * UPSTREAM 401 and is a different thing.)
 */
function authFailureResponse(path: string, failure: AuthFailure): Response {
	if (path === '/api/rpc') {
		const type = failure.status === 401 ? 'auth' : failure.status === 403 ? 'forbidden' : 'error'
		return Response.json({ error: { type, message: failure.reason } }, { status: failure.status })
	}
	const response = error(failure.status, failure.reason)
	if (path === '/api/source/github/callback' || path.startsWith('/api/source/github/manifest/')) {
		response.headers.set('cache-control', 'no-store')
		response.headers.set('referrer-policy', 'no-referrer')
		response.headers.set('x-content-type-options', 'nosniff')
	}
	return response
}

/**
 * An `AuthContext` whose `can()` always allows (the built-in admin = `*`), wrapping a real context so
 * `principal` / `scopedTo` / `audit` keep delegating to the genuine authenticated identity. Used only
 * for a caller whose verified email is a bootstrap admin — they get full access without any IAM
 * grant. The principal is the REAL one (not synthesized), so audit + row-stamping stay accurate.
 */
class BootstrapAdminAuthContext implements AuthContext {
	readonly ok = true
	readonly principal: PrincipalIdentity | null

	constructor(private readonly inner: AuthContext) {
		this.principal = inner.principal
	}

	can(_action: string, _scope?: Scope): boolean {
		// Bootstrap admin = the built-in global `admin` role — every action, every scope.
		return true
	}

	scopedTo(action: string, dimension: string): string[] | null {
		// Unrestricted (admin) — null means "holds the action globally" (see AuthContext.scopedTo).
		return this.inner.scopedTo(action, dimension)
	}

	audit(event: DomainEvent): Promise<void> {
		return this.inner.audit(event)
	}
}

/** Scope builders for the two fabrika dimensions (src/actions.ts). */
export function appScope(appId: string): Scope {
	return { type: SCOPES.APP, value: appId }
}
export function envScope(env: string): Scope {
	return { type: SCOPES.ENVIRONMENT, value: env }
}
