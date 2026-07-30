import type { AuthCarrier, Iam } from '@fabrika/auth'
import type { AppGates } from '@fabrika/auth-core'
import { OPERATIONS_RELEASE_RECONCILE_PATH, OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'
import { handleSourceMapUploadRequest } from './artifact-upload.js'
import { handleOperationsCatalogRequest } from './catalog.js'
import { handleDirectIngestRequest } from './direct-ingest.js'
import type { HealthRepository } from './health-repository.js'
import { handleOperationsOperatorRequest } from './operator-api.js'
import type { OperationsDataEnv } from './pipeline.js'
import { handleOperationsReleaseRequest } from './releases.js'

const INGEST_PATH = /^\/api\/[1-9][0-9]{0,18}\/envelope\/$/
const CATALOG_PATH = '/private/catalog/reconcile'
const OPERATOR_GATES: AppGates = {
	rules: [
		{ path: '/api/*', kind: 'service' },
		{ path: '/api/*', kind: 'human' },
	],
}

export interface OperationsHttpEnv extends OperationsDataEnv {
	/** Hostname published for SDK envelope ingest and authenticated source-map upload. Empty disables public ingress. */
	publicHost: string
	/** Private Control → Operations catalog credential. */
	syncKey: string
	/** Operations owns operator authentication and IAM principal lookup. */
	iam: Iam
	/** Portable health persistence used by the operator API. */
	health: HealthRepository
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
			if (url.pathname === OPERATIONS_RELEASE_RECONCILE_PATH) {
				return handleOperationsReleaseRequest(request, { repositories: env.repositories, syncKey: env.syncKey })
			}
			if (url.pathname.startsWith('/api/')) {
				const context: AuthCarrier = {}
				return env.iam.authMiddleware({ gates: OPERATOR_GATES, unmatched: 'deny' })(request, context, async () => {
					if (context.auth === undefined || context.auth === null) return Response.json({ error: 'authentication required' }, { status: 401 })
					return handleOperationsOperatorRequest(request, {
						repositories: env.repositories,
						health: env.health,
						payloads: env.payloads,
						auth: context.auth,
						principals: env.iam,
					})
				})
			}
			return notFound()
		} catch {
			console.error('operations request failed')
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
