import { type AuthContext, defineApp, type Middleware, type RequestExecutionContext, route } from '@fabrika/app'
import { anonymousContext, createIam } from '@fabrika/auth'
import { exampleAppId } from '../fabrika.gates'
import { type Env, readIamIssuer } from './env'

interface Ctx {
	auth?: AuthContext
	exec: RequestExecutionContext
}

/**
 * The proxy is the front door: it matched this request against `fabrika.gates.ts` and, unless the gate
 * was `public`, injected an access token. The app re-verifies that token locally against IAM's JWKS —
 * the header is never trusted blindly — and turns it into an `AuthContext`. It evaluates no gate.
 */
const authMiddleware = (env: Env): Middleware<Ctx> => {
	const iam = createIam({ IAM: env.IAM, FABRIKA_IAM_ISSUER: readIamIssuer(env), FABRIKA_APP_ID: exampleAppId })
	return async (request, ctx, next) => {
		const result = await iam.authenticate(request)
		if (result.ok) {
			ctx.auth = result.context
			return next()
		}
		// No token = the proxy admitted this through a `public` gate. That is anonymous, not an error.
		if (result.reason !== 'no_token') {
			return new Response(result.reason, { status: result.status })
		}
		ctx.auth = anonymousContext()
		return next()
	}
}

export const app = defineApp<Env, Ctx>({
	context: (_env, _request, exec) => ({ exec }),
	middleware: (env) => [authMiddleware(env)],
	routes: [
		route.get('/public/hello', () => new Response('public')),
		route.get('/', (ctx) => {
			if (ctx.auth === undefined) {
				throw new Error('auth middleware did not provide a context')
			}
			// Authorization is identical everywhere — `can()` / `scopedTo()` over the resolved permissions,
			// here read straight from the locally-verified token's claims. A `public` request is anonymous
			// (`principal: null`, empty perms), so `can()` is always false there.
			const body = {
				authenticated: true,
				principal: ctx.auth.principal,
				canEditDemoProject: ctx.auth.can('example.settings.update', { type: 'project', value: 'demo' }),
				readableProjects: ctx.auth.scopedTo('example.read', 'project'),
			}

			// Fire-and-forget domain audit — never blocks the response.
			ctx.exec.waitUntil(ctx.auth.audit({ action: 'example.view', resourceType: 'example', resourceId: 'demo' }))
			return Response.json(body)
		}),
	],
})
