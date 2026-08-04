/**
 * IAM middleware + runtime ACL helpers for the control plane.
 *
 * The application middleware authenticates each `/api/*` request once and stores the resolved
 * `AuthContext` on the request context. The API router only performs action and scope checks against
 * that context. The GitHub webhook remains outside this guard and is HMAC-gated instead.
 */
import {
	type AppGates,
	type AuthCarrier,
	type AuthContext,
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
 * The per-path gates fabrika's control surface enforces in-process as defence in depth. The public
 * Cloudflare proxy uses the same ordered rules before this Worker. Every `/api/*` route admits EITHER a machine `px_` key
 * (automation / CI) OR a logged-in human (the dashboard via SSO) — two precedence-ordered rules
 * sharing the glob, exactly like the example app's two-rule gated host. Health, the webhook and the
 * M2 `POST /api/runs` relay are handled BEFORE this guard (index.ts), so they never reach the gates.
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
	/** IAM's origin — the token issuer and `/auth/login` redirect base. */
	FABRIKA_IAM_URL?: string
	/**
	 * JSON array of bootstrap-admin emails (normally `'[]'`). A caller whose verified email is listed
	 * here is authorized as admin (`can` → true for every action) even when IAM denies — the
	 * escape hatch for the first operator before IAM knows about fabrika.
	 */
	FABRIKA_CONTROL_BOOTSTRAP_ADMINS?: string
	/**
	 * The seeded IAM provisioning key (a `px_` bearer, also fabrika's reconcile credential). A request
	 * bearing it is authorized as a synthetic global-admin — the machine bootstrap escape hatch.
	 * Empty/unset disables it.
	 */
	FABRIKA_IAM_PROVISIONING_KEY?: string
	/**
	 * The control plane's own public domain. Read here for ONE reason: it is the authority on whether the
	 * BROWSER spoke HTTPS, which decides the `px_token` cookie's `Secure` flag — see `secureCookies`.
	 */
	FABRIKA_CONTROL_DOMAIN?: string
}

/**
 * Whether the freshly minted `px_token` cookie must carry `Secure`.
 *
 * `PropustkaAuth` otherwise derives it from the REQUEST's protocol, and that is wrong behind a
 * TLS-TERMINATING BALANCER — Zerops' project L7 balancer, or any reverse proxy: the browser spoke
 * HTTPS, the process sees plain HTTP on the private network, and a permission-token cookie set without
 * `Secure` there is one downgrade away from being sent in the clear. The configured public domain is
 * the authority on what the browser actually spoke, so a configured domain forces `Secure`.
 *
 * Returning `undefined` (no domain: local dev, or a *.workers.dev stage) keeps the derived behaviour.
 * WIDENING ONLY — everything that was `Secure` before still is, so the Cloudflare path is unchanged
 * (there the request protocol is https either way).
 */
function secureCookies(env: IamEnv): true | undefined {
	const domain = env.FABRIKA_CONTROL_DOMAIN
	return domain !== undefined && domain.trim() !== '' ? true : undefined
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
 * The application-framework auth front door. It uses the public IAM SDK for normal dev and
 * production authentication, then applies the two control-only bootstrap hatches to the resolved context.
 */
export function controlAuthMiddleware<Ctx extends AuthCarrier>(env: IamEnv): Middleware<Ctx> {
	const secure = secureCookies(env)
	const iam = createAppIam(env, {
		appId: VOZKA_APP_ID,
		devPersonas: SDK_DEV_PERSONAS,
		devDefaultPersona: DEV_DEFAULT_EMAIL,
		devPersonaCookie: DEV_PERSONA_COOKIE,
		devPersonaHeader: DEV_PRINCIPAL_HEADER,
		...(secure === undefined ? {} : { forceSecureCookies: secure }),
	})
	const bootstrapAdmins = parseBootstrapAdmins(env.FABRIKA_CONTROL_BOOTSTRAP_ADMINS)
	const provisioningKey = (env.FABRIKA_IAM_PROVISIONING_KEY ?? '').trim()
	const authenticate = iam.authMiddleware<Ctx>({
		gates: CONTROL_GATES,
		onError(request, failure) {
			if (new URL(request.url).pathname === '/api/rpc') {
				const type = failure.status === 401 ? 'auth' : failure.status === 403 ? 'forbidden' : 'error'
				return Response.json({
					error: {
						type,
						message: failure.reason,
						...(failure.loginUrl === undefined ? {} : { loginUrl: failure.loginUrl }),
					},
				}, { status: failure.status })
			}
			return error(
				failure.status,
				failure.reason,
				failure.loginUrl === undefined ? undefined : { loginUrl: failure.loginUrl },
			)
		},
	})

	return async (request, ctx, next) => {
		const path = new URL(request.url).pathname
		if (!path.startsWith('/api/') || path === '/api/health') return next()

		if (provisioningKey !== '') {
			const bearer = readBearerToken(request.headers.get('Authorization'))
			if (bearer !== null && constantTimeEqual(bearer, provisioningKey)) {
				ctx.auth = makeProvisioningContext()
				return next()
			}
		}

		return authenticate(request, ctx, async () => {
			const auth = ctx.auth
			const principal = auth?.principal
			if (
				auth !== undefined
				&& auth !== null
				&& principal !== undefined
				&& principal !== null
				&& principal.type === 'user'
				&& bootstrapAdmins.has(principal.label)
			) {
				ctx.auth = new BootstrapAdminAuthContext(auth)
			}
			return next()
		})
	}
}

/** The synthetic principal a provisioning-key request resolves to. */
const PROVISIONING_PRINCIPAL: PrincipalIdentity = { id: 'provisioning-admin', type: 'service', label: 'provisioning' }

/** A global-admin AuthContext for the provisioning key: every action allowed, no real grants, no audit sink. */
function makeProvisioningContext(): AuthContext {
	return { ok: true, principal: PROVISIONING_PRINCIPAL, can: () => true, scopedTo: () => null, audit: () => Promise.resolve() }
}

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
function readBearerToken(header: string | null): string | null {
	if (header === null) {
		return null
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	return match === null ? null : match[1]
}

/** Constant-time string compare (length-checked) — avoids leaking the provisioning key by timing. */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false
	}
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return diff === 0
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
