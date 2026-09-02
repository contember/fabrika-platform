/**
 * The control plane's own CSRF guard. `SameSite=Lax` stops cross-SITE forgery but not a same-site
 * cross-ORIGIN one, and the RPC dispatcher parses JSON whatever the `Content-Type` — so a page on a
 * sibling host rides the operator's session with no preflight. Not a gate evaluator (ADR-0022).
 */
import type { AuthCarrier, AuthContext, Middleware } from '@fabrika/auth'
import { error } from './http'
import { controlPublicOrigin, type IamEnv } from './iam'

/** An ALLOWLIST, never a denylist: a method invented later must be checked, not skipped. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const CROSS_ORIGIN = 'cross-origin request rejected'

/** Runs AFTER `controlAuthMiddleware`, so `ctx.auth` can tell a machine principal from a person. */
export function controlOriginGuard<Ctx extends AuthCarrier>(env: Pick<IamEnv, 'FABRIKA_CONTROL_DOMAIN'>): Middleware<Ctx> {
	const expected = controlPublicOrigin(env)
	return (request, ctx, next) => {
		const path = canonicalPath(request.url)
		if (!guarded(path) || SAFE_METHODS.has(request.method)) return next()
		if (exempt(request, ctx.auth)) return next()
		return sameOrigin(request, expected) ? next() : Promise.resolve(refusal(path))
	}
}

/**
 * The path as the ROUTER sees it: `matchRoutes` splits on `/` and drops empty segments
 * (`packages/app/src/router.ts`), so `//api/rpc` reaches the RPC route while `startsWith('/api/')` is
 * false for it. Deriving the same way is what stops a doubled slash skipping this guard.
 */
function canonicalPath(url: string): string {
	return `/${new URL(url).pathname.split('/').filter((segment) => segment !== '').join('/')}`
}

/** Every authenticated `/api/*` route; `/api/health` is public and `/api` itself is the SPA. */
function guarded(path: string): boolean {
	return path.startsWith('/api/') && path !== '/api/health'
}

/**
 * CSRF is a defense against AMBIENT authority, so the signal is the credential's shape, not the
 * identity: a page cannot attach `Authorization` cross-origin without a preflight nothing here
 * answers, and a non-user principal is a machine. Anonymous and unauthenticated are CHECKED.
 */
function exempt(request: Request, auth: AuthContext | null | undefined): boolean {
	if (request.headers.get('Authorization') !== null) return true
	const principal = auth === undefined || auth === null ? null : auth.principal
	return principal !== null && principal.type !== 'user'
}

/**
 * The same rule as IAM's `sameOrigin` (`packages/iam/src/auth/routes.ts`), compared against the
 * CONFIGURED public origin: behind a TLS-terminating balancer `new URL(request.url).origin` is
 * `http://host` while the browser truthfully sent `https://host` (backlog 50).
 */
function sameOrigin(request: Request, expected: string | undefined): boolean {
	const fetchSite = request.headers.get('Sec-Fetch-Site')
	if (fetchSite !== null && fetchSite !== 'same-origin') return false
	if (expected === undefined) return false
	const originHeader = request.headers.get('Origin')
	// A same-origin post from a `no-referrer` page serializes its origin as `null`; `Sec-Fetch-Site` is
	// then the only proof left, and a page cannot forge it (`Sec-` is a forbidden header prefix).
	if (originHeader === 'null') return fetchSite === 'same-origin'
	const origin = originHeader ?? originOf(request.headers.get('Referer'))
	return origin === null ? false : originOf(origin) === expected
}

function originOf(value: string | null): string | null {
	if (value === null) return null
	try {
		return new URL(value).origin
	} catch {
		return null
	}
}

/** The RPC surface's structural error shape, the REST surface's flat one — mirrors `iam.ts`. */
function refusal(path: string): Response {
	return path === '/api/rpc'
		? Response.json({ error: { type: 'forbidden', message: CROSS_ORIGIN } }, { status: 403 })
		: error(403, CROSS_ORIGIN)
}
