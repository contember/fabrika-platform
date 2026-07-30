import { OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'
import { handleSourceMapUploadRequest } from './artifact-upload.js'
import { handleOperationsCatalogRequest } from './catalog.js'
import { handleDirectIngestRequest } from './direct-ingest.js'
import type { OperationsDataEnv } from './pipeline.js'

const INGEST_PATH = /^\/api\/[1-9][0-9]{0,18}\/envelope\/$/
const CATALOG_PATH = '/private/catalog/reconcile'

export interface OperationsHttpEnv extends OperationsDataEnv {
	/** Hostname published for SDK envelope ingest and authenticated source-map upload. Empty disables public ingress. */
	publicHost: string
	/** Private Control → Operations catalog credential. */
	syncKey: string
}

/**
 * The common HTTP boundary for Workers and Bun.
 *
 * A request arriving on the public hostname can reach exactly two data-plane routes: Sentry-compatible
 * envelope ingest and credential-scoped source-map upload. Operator and catalog requests must use the
 * private service address, even when they carry valid credentials. This keeps transport isolation
 * independent of application authorization.
 */
export function createOperationsFetchHandler(env: OperationsHttpEnv): (request: Request) => Promise<Response> {
	return async (request): Promise<Response> => {
		try {
			const url = new URL(request.url)
			if (isPublicIngress(url, env.publicHost)) {
				if (INGEST_PATH.test(url.pathname)) {
					return handleDirectIngestRequest(request, { repositories: env.repositories, queue: env.ingestQueue })
				}
				if (url.pathname === OPERATIONS_SOURCE_MAP_UPLOAD_PATH) {
					return handleSourceMapUploadRequest(request, { repositories: env.repositories, artifacts: env.payloads })
				}
				return notFound()
			}
			if (url.pathname === '/healthz') {
				return Response.json({ status: 'ok' })
			}
			if (url.pathname === CATALOG_PATH) {
				return handleOperationsCatalogRequest(request, { repositories: env.repositories, syncKey: env.syncKey })
			}
			// The operator API is wired here once its runtime-neutral HTTP handler lands.
			return notFound()
		} catch (error) {
			console.error('operations request failed:', error instanceof Error ? error.message : 'unknown error')
			return Response.json({ error: 'internal error' }, { status: 500 })
		}
	}
}

function isPublicIngress(url: URL, publicHost: string): boolean {
	return publicHost !== '' && url.hostname.toLowerCase() === publicHost.toLowerCase()
}

function notFound(): Response {
	return Response.json({ error: 'not found' }, { status: 404 })
}
