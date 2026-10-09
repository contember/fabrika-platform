import type { FabrikaApp } from '@fabrika/app'
import { dispatchRpcRequest, serveService } from '@fabrika/app/service'
import { type AuthCarrier, type AuthContext, type Iam } from '@fabrika/auth'
import { handleSourceMapUploadRequest } from './artifact-upload.js'
import { handleOperationsCatalogRequest } from './catalog.js'
import { handleDirectIngestRequest } from './direct-ingest.js'
import type { HealthRepository } from './health-repository.js'
import { operationsRpcRouter } from './operator-rpc.js'
import type { OperationsDataEnv } from './pipeline.js'
import { handleOperationsReleaseRequest } from './releases.js'
import { OPERATIONS_PRIVATE_SERVICE, OPERATIONS_PUBLIC_SERVICE } from './service.js'

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

/** What an operator procedure receives: the verified caller of the request. */
interface OperationsRpcContext extends AuthCarrier {
	auth: AuthContext
	readonly env: OperationsAppEnv
	readonly request: Request
}

const onError = (): Response => {
	console.error('operations request failed')
	return Response.json({ error: 'internal error' }, { status: 500 })
}

/** The public hostname: ingest and the source-map upload, each checking its own credential. */
const publicService = serveService<'ingest' | 'source-map-upload', OperationsAppEnv>(OPERATIONS_PUBLIC_SERVICE, {
	'ingest': ({ request, env }) => {
		if (!INGEST_PATH.test(new URL(request.url).pathname)) {
			return Response.json({ error: 'not found' }, { status: 404 })
		}
		return handleDirectIngestRequest(request, { repositories: env.repositories, queue: env.ingestQueue })
	},
	'source-map-upload': ({ request, env }) => handleSourceMapUploadRequest(request, { repositories: env.repositories, artifacts: env.payloads }),
}, { onError })

/** Every other host: the private network, which only Control and the platform's liveness probe dial. */
const privateService = serveService<'health' | 'rpc' | 'catalog-reconcile' | 'release-reconcile', OperationsAppEnv>(OPERATIONS_PRIVATE_SERVICE, {
	'health': () => Response.json({ status: 'ok' }),
	'rpc': operatorRpc,
	'catalog-reconcile': ({ request, env }) => handleOperationsCatalogRequest(request, { repositories: env.repositories, syncKey: env.syncKey }),
	'release-reconcile': ({ request, env }) => handleOperationsReleaseRequest(request, { repositories: env.repositories, syncKey: env.syncKey }),
}, { onError })

/**
 * Operations as the same runtime-neutral service on Workers and Bun. The request's host picks the table: the public
 * hostname is served only `OPERATIONS_PUBLIC_SERVICE`, anything else only `OPERATIONS_PRIVATE_SERVICE`.
 */
export const operationsApp: FabrikaApp<OperationsAppEnv> = {
	fetch(request, env, exec) {
		const service = isPublicIngress(new URL(request.url), env.publicHost) ? publicService : privateService
		return service.fetch(request, env, exec)
	},
}

/** The injected token, verified locally; every procedure then authorizes itself. */
async function operatorRpc({ request, env }: { readonly request: Request; readonly env: OperationsAppEnv }): Promise<Response> {
	const result = await env.iam.authenticate(request)
	if (!result.ok) {
		const type = result.status === 401 ? 'auth' : result.status === 403 ? 'forbidden' : 'error'
		return Response.json({ error: { type, message: 'authentication required' } }, { status: result.status })
	}
	const ctx: OperationsRpcContext = { env, request, auth: result.context }
	return dispatchRpcRequest({ router: operationsRpcRouter, ctx, request })
}

function isPublicIngress(url: URL, publicHost: string): boolean {
	return publicHost !== '' && url.hostname.toLowerCase() === publicHost.toLowerCase()
}
