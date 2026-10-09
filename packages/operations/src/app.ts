import { defineApp, type Route, route } from '@fabrika/app'
import { type AuthCarrier, type AuthContext, type Iam } from '@fabrika/auth'
import { OPERATIONS_RELEASE_RECONCILE_PATH, OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'
import { handleSourceMapUploadRequest } from './artifact-upload.js'
import { handleOperationsCatalogRequest } from './catalog.js'
import { handleDirectIngestRequest } from './direct-ingest.js'
import type { HealthRepository } from './health-repository.js'
import { operationsRpcRouter } from './operator-rpc.js'
import type { OperationsDataEnv } from './pipeline.js'
import { handleOperationsReleaseRequest } from './releases.js'

const INGEST_PATH = /^\/api\/[1-9][0-9]{0,18}\/envelope\/$/
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

export interface OperationsAppContext extends AuthCarrier {
	auth?: AuthContext | null
	readonly env: OperationsAppEnv
	readonly request: Request
}

/** The routes `operationsApp` serves; exported so the B10 route-coverage test reads the live list. */
export const operationsRoutes: Route<OperationsAppContext>[] = [
	route.all('/healthz', (ctx) =>
		isPublicIngress(new URL(ctx.request.url), ctx.env.publicHost)
			? notFound()
			: Response.json({ status: 'ok' })),
	route.all('/api/:projectId/envelope/', (ctx) => directIngest(ctx)),
	route.all(OPERATIONS_SOURCE_MAP_UPLOAD_PATH, (ctx) => sourceMapUpload(ctx)),
	route.all('/private/catalog/reconcile', (ctx) => catalogReconcile(ctx)),
	route.all(OPERATIONS_RELEASE_RECONCILE_PATH, (ctx) => releaseReconcile(ctx)),
	route.rpc('/api/rpc', operationsRpcRouter, { use: [privateOperatorRoute] }),
	route.all('/*path', () => notFound()),
]

/** Operations as the same runtime-neutral Fabrika application on Workers and Bun. */
export const operationsApp = defineApp<OperationsAppEnv, OperationsAppContext>({
	context: (env, request) => ({ env, request }),
	routes: operationsRoutes,
	onError() {
		console.error('operations request failed')
		return Response.json({ error: 'internal error' }, { status: 500 })
	},
})

async function privateOperatorRoute(request: Request, ctx: OperationsAppContext, next: () => Promise<Response>): Promise<Response> {
	if (isPublicIngress(new URL(request.url), ctx.env.publicHost)) return notFound()
	const result = await ctx.env.iam.authenticate(request)
	if (!result.ok) {
		const type = result.status === 401 ? 'auth' : result.status === 403 ? 'forbidden' : 'error'
		return Response.json({ error: { type, message: 'authentication required' } }, { status: result.status })
	}
	ctx.auth = result.context
	return next()
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

function isPublicIngress(url: URL, publicHost: string): boolean {
	return publicHost !== '' && url.hostname.toLowerCase() === publicHost.toLowerCase()
}

function notFound(): Response {
	return Response.json({ error: 'not found' }, { status: 404 })
}
