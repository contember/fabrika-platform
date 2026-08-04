/**
 * IAM middleware + runtime ACL helpers for the control plane.
 *
 * The application middleware resolves each `/api/*` request's caller ONCE — from the token the proxy
 * injected, verified locally against IAM's JWKS — and stores the resulting `AuthContext` on the request
 * context. The API router only performs action and scope checks against that context. The GitHub
 * webhook remains outside this guard and is HMAC-gated instead.
 *
 * Nothing here evaluates a gate: since ADR-0007 the proxy is the only enforcement point, and it has
 * already refused (or bounced to login) anything that does not satisfy `CONTROL_GATES`.
 */
import {
	type AppGates,
	type AuthCarrier,
	type AuthContext,
	type AuthFailure,
	createIam as createAppIam,
	type DomainEvent,
	type IamRpc,
	type Middleware,
	type PersonaSpec,
	type PrincipalIdentity,
	type Scope,
} from '@fabrika/auth'
import { type ACTIONS, SCOPES, VOZKA_APP_ID } from './actions'
import { error } from './http'

/**
 * The per-path gates fabrika's control surface is fronted by. They are the source of
 * `CONTROL_PROXY_GATES` in `fabrika.config.ts` — the proxy manifest — and are NOT evaluated here.
 * Every `/api/*` route admits EITHER a machine `px_` key (automation / CI) OR a logged-in human (the
 * dashboard via SSO): two precedence-ordered rules sharing the glob. Health, the webhook and the
 * `POST /api/runs` relay are handled BEFORE this guard (index.ts), so they never reach the gates.
 */
export const CONTROL_GATES: AppGates = {
	rules: [
		{ path: '/api/*', kind: 'service' },
		{ path: '/api/*', kind: 'human' },
	],
}

/** The bindings + vars the IAM factory needs (a subset of the Worker `Env`). */
export interface IamEnv {
	IAM?: IamRpc
	DEV: string
	/** Deployment stage. `DEV` selects the persona path only when this is exactly `local`. */
	ENVIRONMENT?: string
	/** IAM's origin — the issuer every token is verified against. */
	FABRIKA_IAM_URL?: string
	/**
	 * JSON array of bootstrap-admin emails (normally `'[]'`). A caller whose verified email is listed
	 * here is authorized as admin (`can` → true for every action) even when IAM denies — the
	 * escape hatch for the first operator before IAM knows about fabrika.
	 */
	FABRIKA_CONTROL_BOOTSTRAP_ADMINS?: string
	/** The control plane's own public domain — the CSRF guard's authority (see `controlPublicOrigin`). */
	FABRIKA_CONTROL_DOMAIN?: string
}

/**
 * The console's own public origin, from `FABRIKA_CONTROL_DOMAIN`.
 *
 * That variable has no settled shape and never needed one, because its only consumer read it for
 * truthiness: the local stack sets a full origin (`http://control.fabrika.localhost:18080`) and a
 * live installation a bare host (`proxy-…zerops.app`). Now that the CSRF guard compares against it
 * (backlog 50), both spellings have to mean the same thing — a bare host is assumed `https`, which is
 * the only scheme a public host is served on.
 *
 * Returns `undefined` when nothing usable is configured; the guard then fails closed.
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
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) {
			return new Set()
		}
		return new Set(parsed.filter((v): v is string => typeof v === 'string'))
	} catch {
		return new Set()
	}
}

/** Header (preferred) + cookie used by the SDK dev persona switch. */
export const DEV_PRINCIPAL_HEADER = 'X-Dev-Principal'
export const DEV_PERSONA_COOKIE = 'vozka_dev_principal'
/** Default dev persona (no selector) — the admin, so plain `bun run dev` can click everything. */
export const DEV_DEFAULT_EMAIL = 'admin@vozka.test'

/**
 * DEV-only people directory — the local stand-in for the IAM Worker's principals/grants. Keyed by
 * email (the persona selector the header / cookie carries). Permissions mirror the fabrika taxonomy
 * (src/actions.ts):
 *   - admin    → `*`                   (every action, every scope)
 *   - operator → `deploy.*` global     (trigger + read any deploy, no registry mgmt)
 *   - viewer   → `deploy.read` global  (read-only)
 */
const SDK_DEV_PERSONAS: Record<string, PersonaSpec> = {
	'admin@vozka.test': { id: 'mem-admin', label: 'admin@vozka.test', type: 'user', permissions: [{ action: '*', scope: null }] },
	'operator@vozka.test': {
		id: 'mem-operator',
		label: 'operator@vozka.test',
		type: 'user',
		permissions: [{ action: 'deploy.*', scope: null }],
	},
	'viewer@vozka.test': {
		id: 'mem-viewer',
		label: 'viewer@vozka.test',
		type: 'user',
		permissions: [{ action: 'deploy.read', scope: null }],
	},
}

/**
 * The application-framework auth front door: resolve the caller through the public IAM SDK (the
 * proxy-injected token, verified locally), then apply the one control-only bootstrap hatch.
 *
 * There used to be a second hatch here — a request bearing `FABRIKA_IAM_PROVISIONING_KEY` was
 * authorized as a synthetic global admin. It was DEAD CODE behind the proxy and could not be
 * revived: `/api/*` is gated `service`, the proxy resolves a `px_` bearer by asking IAM to mint from
 * it, and the provisioning key has no `credentials` row — IAM resolves it specially, in
 * `resolveCaller`, for its OWN `/admin/*` surface. So `mintFromKey` answered `invalid_key` and the
 * request was refused before control ever saw the bearer. One mechanism per job: machine access to
 * the control plane is an IAM-ISSUED SERVICE KEY, which is a real credential the proxy can exchange,
 * and which an operator obtains with the provisioning key over IAM's admin surface. See
 * `docs/reference/human-authentication.md`.
 */
export function controlAuthMiddleware<Ctx extends AuthCarrier>(env: IamEnv): Middleware<Ctx> {
	const iam = createAppIam(env, {
		appId: VOZKA_APP_ID,
		devPersonas: SDK_DEV_PERSONAS,
		devDefaultPersona: DEV_DEFAULT_EMAIL,
		devPersonaCookie: DEV_PERSONA_COOKIE,
		devPersonaHeader: DEV_PRINCIPAL_HEADER,
	})
	const bootstrapAdmins = parseBootstrapAdmins(env.FABRIKA_CONTROL_BOOTSTRAP_ADMINS)

	return async (request, ctx, next) => {
		const path = new URL(request.url).pathname
		if (!path.startsWith('/api/') || path === '/api/health') return next()

		const result = await iam.authenticate(request)
		if (!result.ok) {
			return authFailureResponse(path, result)
		}
		const principal = result.context.principal
		ctx.auth = principal !== null && principal.type === 'user' && bootstrapAdmins.has(principal.label)
			? new BootstrapAdminAuthContext(result.context)
			: result.context
		return next()
	}
}

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
	return error(failure.status, failure.reason)
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

/** The authenticated caller, surfaced to handlers so mutations can `auth.audit(...)`. */
export interface Authorized {
	ok: true
	/** The authenticated caller's AuthContext — for `can`-gated handlers to `audit` + stamp rows. */
	auth: AuthContext
}

/**
 * Check `action` within an optional `scope` against the context resolved by application middleware.
 * The router returns the 403 response verbatim; successful mutations receive the same context for audit.
 */
export function authorize(
	auth: AuthContext,
	action: (typeof ACTIONS)[keyof typeof ACTIONS],
	scope?: Scope,
): Authorized | { ok: false; response: Response } {
	if (!auth.can(action, scope)) {
		return { ok: false, response: error(403, `not authorized: ${action}`) }
	}
	return { ok: true, auth }
}
