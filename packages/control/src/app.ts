import { type AuthContext, defineApp, type RequestExecutionContext, route } from '@fabrika/app'
import type { ControlProvider } from '@fabrika/provider-contract'
import { handleApi } from './api/router'
import type { Env } from './env'
import { error } from './http'
import { controlAuthMiddleware } from './iam'
import { forwardIamAdmin } from './iam-admin'
import { forwardOperationsApi } from './operations-gateway'
import { buildApiDeps, repositories, repoSource } from './services'
import { handleWebhook } from './webhook'

export interface ControlAppEnv {
	readonly env: Env
	readonly provider: ControlProvider
}

interface ControlAppContext {
	auth?: AuthContext | null
	readonly env: Env
	readonly provider: ControlProvider
	readonly request: Request
}

/**
 * Delivery as a first-party Fabrika application. Provider and runtime ports are supplied by the
 * composition root; request routing and IAM middleware are shared by Workers and Bun.
 */
export const controlApp = defineApp<ControlAppEnv, ControlAppContext>({
	context: ({ env, provider }, request, exec) => ({
		env: withRequestExecution(env, exec),
		provider,
		request,
	}),
	middleware: ({ env }) => [controlAuthMiddleware(env)],
	routes: [
		route.all('/healthz', () => Response.json({ status: 'ok' })),
		route.all('/api/health', () => Response.json({ status: 'ok', service: 'vozka', milestone: 'M4' })),
		route.post('/webhooks/github', (ctx) =>
			handleWebhook(ctx.request, {
				repositories: repositories(ctx.env),
				repoSource: repoSource(ctx.env),
				queue: ctx.env.DEPLOY_QUEUE,
			})),
		route.all('/iam/admin', (ctx) => iamAdmin(ctx)),
		route.all('/iam/admin/*path', (ctx) => iamAdmin(ctx)),
		route.all('/operations/api', (ctx) => operationsApi(ctx)),
		route.all('/operations/api/*path', (ctx) => operationsApi(ctx)),
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
	return forwardIamAdmin(ctx.request, {
		gateway,
		...(ctx.env.PROPUSTKA_URL === undefined ? {} : { publicIamUrl: ctx.env.PROPUSTKA_URL }),
	})
}

function operationsApi(ctx: ControlAppContext): Promise<Response> {
	const gateway = ctx.env.OPERATIONS
	if (gateway === undefined) {
		return Promise.resolve(Response.json({ error: 'operations unavailable' }, { status: 503 }))
	}
	return forwardOperationsApi(ctx.request, {
		gateway,
		...(ctx.env.PROPUSTKA_URL === undefined ? {} : { publicIamUrl: ctx.env.PROPUSTKA_URL }),
	})
}
