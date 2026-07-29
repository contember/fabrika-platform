import { type AuthContext, defineApp, type Middleware, type RequestExecutionContext, route } from '@fabrika/app'
import { PropustkaAuth } from '@fabrika/auth'
import { exampleGates } from '../propustka.gates'
import type { Env } from './env'

interface Ctx {
	auth?: AuthContext
	exec: RequestExecutionContext
}

// Minimal example app on the propustka-NATIVE auth path. `PropustkaAuth` is the whole front door:
// it enforces the per-path gates (`propustka.gates.ts`) in-process — there is no Cloudflare Access
// edge — then resolves the matched credential, verifying the per-app permission token LOCALLY
// against propustka's JWKS (no per-request round-trip). A human with no session is handed a login
// URL to bounce to propustka's OIDC login; a `public` path needs no credential at all.
const authMiddleware = (env: Env): Middleware<Ctx> => {
	return async (request, ctx, next) => {
		const auth = new PropustkaAuth(env.IAM, 'example-app', { issuer: env.PROPUSTKA_ISSUER, gates: exampleGates })
		const result = await auth.authenticate(request)
		if (!result.ok) {
			// A human-gated miss carries a login URL (bounce the browser); anything else is a flat status.
			if (result.loginUrl !== undefined) {
				return Response.redirect(result.loginUrl, 302)
			}
			return new Response(result.reason, { status: result.status })
		}
		ctx.auth = result.context
		const response = await next()
		if (result.setCookie === undefined) {
			return response
		}
		const output = new Response(response.body, response)
		output.headers.append('Set-Cookie', result.setCookie)
		return output
	}
}

export const app = defineApp<Env, Ctx>({
	context: (_env, _request, exec) => ({ exec }),
	middleware: (env) => [authMiddleware(env)],
	routes: [
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
