import { defineApp, type Middleware, route } from '@fabrika/app'
import { type AuthCarrier, type AuthContext, type Iam } from '@fabrika/auth'
import type { AppGates } from '@fabrika/auth-core'
import { OPERATIONS_RELEASE_RECONCILE_PATH, OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'
import { handleSourceMapUploadRequest } from './artifact-upload.js'
import { handleOperationsCatalogRequest } from './catalog.js'
import { handleDirectIngestRequest } from './direct-ingest.js'
import type { HealthRepository } from './health-repository.js'
import { handleOperationsOperatorRequest } from './operator-api.js'
import { operationsRpcRouter } from './operator-rpc.js'
import type { OperationsDataEnv } from './pipeline.js'
import { handleOperationsReleaseRequest } from './releases.js'

const INGEST_PATH = /^\/api\/[1-9][0-9]{0,18}\/envelope\/$/
const OPERATOR_GATES: AppGates = {
	rules: [
		{ path: '/api/*', kind: 'service' },
		{ path: '/api/*', kind: 'human' },
	],
}

export interface OperationsAppEnv extends OperationsDataEnv {
	/** Hostname published for SDK envelope ingest and authenticated source-map upload. Empty disables public ingress. */
	publicHost: string
	/** Private Control → Operations catalog credential. */
	syncKey: string
	/** Operations owns operator authentication and IAM principal lookup. */
	iam: Iam
	/** Portable health persistence used by the operator API. */
	health: HealthRepository
}

interface OperationsAppContext extends AuthCarrier {
	auth?: AuthContext | null
	readonly env: OperationsAppEnv
	readonly request: Request
}

/** Operations as the same runtime-neutral Fabrika application on Workers and Bun. */
export const operationsApp = defineApp<OperationsAppEnv, OperationsAppContext>({
	context: (env, request) => ({ env, request }),
	middleware: (env) => [operatorAuthMiddleware(env)],
	routes: [
		route.all('/healthz', (ctx) =>
			isPublicIngress(new URL(ctx.request.url), ctx.env.publicHost)
				? notFound()
				: Response.json({ status: 'ok' })),
		route.all('/api/:projectId/envelope', (ctx) => directIngest(ctx)),
		route.all(OPERATIONS_SOURCE_MAP_UPLOAD_PATH, (ctx) => sourceMapUpload(ctx)),
		route.all('/private/catalog/reconcile', (ctx) => catalogReconcile(ctx)),
		route.all(OPERATIONS_RELEASE_RECONCILE_PATH, (ctx) => releaseReconcile(ctx)),
		route.rpc('/api/rpc', operationsRpcRouter, { use: [privateOperatorRoute] }),
		route.all('/api/*path', (ctx) => operatorApi(ctx)),
		route.all('/*path', () => notFound()),
	],
	onError() {
		console.error('operations request failed')
		return Response.json({ error: 'internal error' }, { status: 500 })
	},
})

async function privateOperatorRoute(_request: Request, ctx: OperationsAppContext, next: () => Promise<Response>): Promise<Response> {
	return isPublicIngress(new URL(ctx.request.url), ctx.env.publicHost) ? notFound() : await next()
}

function operatorAuthMiddleware(env: OperationsAppEnv): Middleware<OperationsAppContext> {
	const authenticate = env.iam.authMiddleware<OperationsAppContext>({ gates: OPERATOR_GATES, unmatched: 'deny' })
	return (request, ctx, next) => {
		const url = new URL(request.url)
		if (isPublicIngress(url, env.publicHost) || !url.pathname.startsWith('/api/')) {
			return next()
		}
		return authenticate(request, ctx, next)
	}
}

function directIngest(ctx: OperationsAppContext): Promise<Response> {
	const url = new URL(ctx.request.url)
	if (!isPublicIngress(url, ctx.env.publicHost) || !INGEST_PATH.test(url.pathname)) {
		return Promise.resolve(notFound())
	}
	return handleDirectIngestRequest(ctx.request, {
		repositories: ctx.env.repositories,
		queue: ctx.env.ingestQueue,
	})
}

function sourceMapUpload(ctx: OperationsAppContext): Promise<Response> {
	if (!isPublicIngress(new URL(ctx.request.url), ctx.env.publicHost)) {
		return Promise.resolve(notFound())
	}
	return handleSourceMapUploadRequest(ctx.request, {
		repositories: ctx.env.repositories,
		artifacts: ctx.env.payloads,
	})
}

function catalogReconcile(ctx: OperationsAppContext): Promise<Response> {
	if (isPublicIngress(new URL(ctx.request.url), ctx.env.publicHost)) {
		return Promise.resolve(notFound())
	}
	return handleOperationsCatalogRequest(ctx.request, {
		repositories: ctx.env.repositories,
		syncKey: ctx.env.syncKey,
	})
}

function releaseReconcile(ctx: OperationsAppContext): Promise<Response> {
	if (isPublicIngress(new URL(ctx.request.url), ctx.env.publicHost)) {
		return Promise.resolve(notFound())
	}
	return handleOperationsReleaseRequest(ctx.request, {
		repositories: ctx.env.repositories,
		syncKey: ctx.env.syncKey,
	})
}

function operatorApi(ctx: OperationsAppContext): Promise<Response> {
	const url = new URL(ctx.request.url)
	if (isPublicIngress(url, ctx.env.publicHost) || url.pathname === '/api') {
		return Promise.resolve(notFound())
	}
	const auth = ctx.auth
	if (auth === undefined || auth === null) {
		return Promise.resolve(Response.json({ error: 'authentication required' }, { status: 401 }))
	}
	return handleOperationsOperatorRequest(ctx.request, {
		repositories: ctx.env.repositories,
		health: ctx.env.health,
		payloads: ctx.env.payloads,
		auth,
		principals: ctx.env.iam,
	})
}

function isPublicIngress(url: URL, publicHost: string): boolean {
	return publicHost !== '' && url.hostname.toLowerCase() === publicHost.toLowerCase()
}

function notFound(): Response {
	return Response.json({ error: 'not found' }, { status: 404 })
}
