/**
 * The public IAM-host auth surface. App session delivery uses a browser-bound handoff; `/auth/mint/*`
 * is intercepted upstream by `src/app.ts` for the proxy. Admin admission belongs to `admin/router.ts`.
 */
import type { RequestContext } from '../env'
import { logoutPage } from '../password-pages'
import { generateRequestId } from '../request-id'
import type { Services } from '../services'
import { getSigner } from '../signing'
import { methodNotAllowed, safeRedirect } from './http'
import { handleLogin } from './login'
import { handleCallback, handleOidcStart } from './oidc'
import type { AuthEnv } from './oidc-flight'
import { handleForgotPassword, handlePasswordAction, handlePasswordLogin } from './password'
import { handleLogout } from './sessions'

/**
 * `clientAddress` is what the composition's ingress observed, or `null` when it cannot see a client
 * (`src/client-address.ts`). It keys the per-client abuse bucket and NOTHING else — it is never an
 * identity, never a credential, and never stored in the clear. Defaulting to `null` is deliberate: a
 * caller that has not been given a trustworthy coordinate gets the account and deployment-wide buckets
 * alone, which is what existed before, rather than one keyed on a guess.
 *
 * `requestId` is the correlation id the composition root allowed (`src/request-id.ts`); a caller that
 * supplies none gets a generated one, never a header read here.
 */
export async function handleAuth(
	request: Request,
	services: Services,
	env: AuthEnv,
	ctx: RequestContext,
	clientAddress: string | null = null,
	requestId: string = generateRequestId(),
): Promise<Response> {
	const url = new URL(request.url)

	if (url.pathname === '/.well-known/jwks.json') {
		return handleJwks(env)
	}
	if (url.pathname === '/auth/login') {
		if (request.method === 'POST') return handlePasswordLogin(request, services, ctx, clientAddress, requestId)
		if (request.method === 'GET') return handleLogin(request, services, env, ctx, requestId)
		return methodNotAllowed()
	}
	if (url.pathname === '/auth/oidc/start') {
		return request.method === 'GET' ? handleOidcStart(request, services, env) : methodNotAllowed()
	}
	if (url.pathname === '/auth/callback') {
		return request.method === 'GET' ? handleCallback(request, services, env, ctx, requestId) : methodNotAllowed()
	}
	if (url.pathname === '/auth/forgot-password') {
		return handleForgotPassword(request, services, ctx, clientAddress)
	}
	if (url.pathname === '/auth/password/enroll') {
		return handlePasswordAction(request, services, ctx, 'enrollment', requestId)
	}
	if (url.pathname === '/auth/password/reset') {
		return handlePasswordAction(request, services, ctx, 'reset', requestId)
	}
	if (url.pathname === '/auth/logout') {
		// Logging out is a state change, so it needs a method that can carry an origin check. A GET
		// stays usable — it renders the same-origin form that posts — because a cross-site
		// `location = '…/auth/logout'` used to revoke the login and every app session under it.
		if (request.method === 'POST') return handleLogout(request, services)
		if (request.method === 'GET') return logoutPage(safeRedirect(url.searchParams.get('redirect'), services.config))
		return methodNotAllowed()
	}
	return new Response('Not found', { status: 404 })
}

async function handleJwks(env: AuthEnv): Promise<Response> {
	const signer = await getSigner(env)
	return Response.json(signer.jwks(), {
		headers: { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' },
	})
}

export { safeRedirect } from './http'
