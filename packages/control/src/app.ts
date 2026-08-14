import { type AuthContext, defineApp, type RequestExecutionContext, route } from '@fabrika/app'
import type { ControlProvider } from '@fabrika/provider-contract'
import { handleApi } from './api/router'
import { controlRpcRouter } from './control-rpc'
import type { Env } from './env'
import { error } from './http'
import { controlAuthMiddleware, controlPublicOrigin } from './iam'
import { forwardIamAdmin } from './iam-admin'
import { forwardOperationsApi } from './operations-gateway'
import { buildApiDeps, repoEvents, repositories } from './services'
import { manifestCallback, manifestHandoff, SourceConnectionWorkflowError } from './source-connection'
import type { SourceConnectionPort } from './source-connection-port'
import { handleWebhook } from './webhook'

export interface ControlAppEnv {
	readonly env: Env
	readonly provider: ControlProvider
	readonly sourceConnection: SourceConnectionPort
}

interface ControlAppContext {
	auth?: AuthContext | null
	readonly env: Env
	readonly provider: ControlProvider
	readonly sourceConnection: SourceConnectionPort
	readonly request: Request
}

/**
 * Delivery as a first-party Fabrika application. Provider and runtime ports are supplied by the
 * composition root; request routing and IAM middleware are shared by Workers and Bun.
 */
export const controlApp = defineApp<ControlAppEnv, ControlAppContext>({
	context: ({ env, provider, sourceConnection }, request, exec) => ({
		env: withRequestExecution(env, exec),
		provider,
		sourceConnection,
		request,
	}),
	middleware: ({ env }) => [controlAuthMiddleware(env)],
	routes: [
		route.all('/healthz', () => Response.json({ status: 'ok' })),
		route.all('/api/health', () => Response.json({ status: 'ok', service: 'vozka', milestone: 'M4' })),
		route.post('/webhooks/github', (ctx) =>
			handleWebhook(ctx.request, {
				repositories: repositories(ctx.env),
				repoSource: repoEvents(ctx.env),
				queue: ctx.env.DEPLOY_QUEUE,
			})),
		route.get(
			'/api/source/github/manifest/:connectionId',
			(ctx, params) => sourceConnectionBrowserCall(ctx, (deps) => manifestHandoff(deps, params.connectionId)),
		),
		route.get('/api/source/github/callback', (ctx) => sourceConnectionBrowserCall(ctx, manifestCallback)),
		route.all('/iam/admin', (ctx) => iamAdmin(ctx)),
		route.all('/iam/admin/*path', (ctx) => iamAdmin(ctx)),
		route.all('/operations/api', (ctx) => operationsApi(ctx)),
		route.all('/operations/api/*path', (ctx) => operationsApi(ctx)),
		route.rpc('/api/rpc', controlRpcRouter),
		route.all('/api/*path', (ctx) => controlApi(ctx)),
		route.all('/*path', (ctx) => ctx.env.ASSETS.fetch(ctx.request)),
	],
	onError(cause) {
		console.error('control request failed:', cause instanceof Error ? cause.message : 'unknown error')
		return new Response('internal error', {
			status: 500,
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		})
	},
})

function sourceConnectionBrowserCall(
	ctx: ControlAppContext,
	handler: (deps: Parameters<typeof manifestHandoff>[0]) => Promise<Response>,
): Promise<Response> {
	if (ctx.auth === undefined || ctx.auth === null) return Promise.resolve(secureBrowserResponse(error(401, 'authentication required')))
	return handler({ env: ctx.env, source: ctx.sourceConnection, auth: ctx.auth, request: ctx.request })
		.then(secureBrowserResponse)
		.catch((cause: unknown) => {
			if (cause instanceof SourceConnectionWorkflowError) return secureBrowserResponse(error(cause.httpStatus, cause.message))
			if (cause instanceof DOMException && cause.name === 'AbortError') return secureBrowserResponse(error(499, 'request cancelled'))
			console.error('source connection request failed')
			return secureBrowserResponse(error(500, 'internal error'))
		})
}

function secureBrowserResponse(response: Response): Response {
	const headers = new Headers(response.headers)
	headers.set('cache-control', 'no-store')
	headers.set('referrer-policy', 'no-referrer')
	headers.set('x-content-type-options', 'nosniff')
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function withRequestExecution(env: Env, exec: RequestExecutionContext): Env {
	return { ...env, WAIT_UNTIL: (promise) => exec.waitUntil(promise) }
}

function controlApi(ctx: ControlAppContext): Promise<Response> {
	if (new URL(ctx.request.url).pathname === '/api') {
		return ctx.env.ASSETS.fetch(ctx.request)
	}
	const auth = ctx.auth
	if (auth === undefined || auth === null) {
		return Promise.resolve(error(401, 'authentication required'))
	}
	return handleApi(ctx.request, buildApiDeps(ctx.env, ctx.provider, auth))
}

function iamAdmin(ctx: ControlAppContext): Promise<Response> {
	const gateway = ctx.env.IAM_ADMIN
	if (gateway === undefined) {
		return Promise.resolve(Response.json({ error: 'IAM admin gateway unavailable' }, { status: 503 }))
	}
	const publicOrigin = controlPublicOrigin(ctx.env)
	return forwardIamAdmin(ctx.request, {
		gateway,
		...(ctx.env.FABRIKA_IAM_URL === undefined ? {} : { publicIamUrl: ctx.env.FABRIKA_IAM_URL }),
		...(publicOrigin === undefined ? {} : { publicOrigin }),
	})
}

function operationsApi(ctx: ControlAppContext): Promise<Response> {
	const gateway = ctx.env.OPERATIONS
	if (gateway === undefined) {
		return Promise.resolve(Response.json({ error: 'operations unavailable' }, { status: 503 }))
	}
	const publicOrigin = controlPublicOrigin(ctx.env)
	return forwardOperationsApi(ctx.request, {
		gateway,
		...(ctx.env.FABRIKA_IAM_URL === undefined ? {} : { publicIamUrl: ctx.env.FABRIKA_IAM_URL }),
		...(publicOrigin === undefined ? {} : { publicOrigin }),
	})
}
