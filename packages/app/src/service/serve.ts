// The dispatcher of a service contract: the service's one router, over the table the proxy decides from.

import {
	compileEndpointTable,
	ENDPOINT_HEADER,
	type InstallationEndpointRow,
	parseEndpointHeader,
	planEndpoint,
	rawRequestTarget,
	requirementDigest,
} from '@fabrika/auth-core'
import type { FabrikaApp, RequestExecutionContext } from '../app.js'
import { defaultOnError, jsonResponse } from '../errors.js'
import type { ServiceArtifact } from './define.js'

export interface ServiceRequest<Env> {
	readonly request: Request
	/** The `:name` segments of the selected path, percent-decoded. */
	readonly params: Readonly<Record<string, string>>
	readonly env: Env
	readonly exec: RequestExecutionContext
}

export type ServiceHandler<Env> = (input: ServiceRequest<Env>) => Response | Promise<Response>

/** One handler per declared row id, also for a row this composition left out; that one is never called. */
export type ServiceHandlers<Id extends string, Env> = { readonly [K in Id]: ServiceHandler<Env> }

export interface ServeServiceOptions<Env> {
	/** Map a value a handler threw to a response. Defaults to the structural error mapping. */
	readonly onError?: (error: unknown, request: Request, env: Env) => Response
}

export class ServiceHandlersError extends Error {
	override readonly name = 'ServiceHandlersError'
}

/**
 * Serve a service contract. Per request: a non-canonical path is a 400, a request no row selects a 404, a `service`
 * row reached without the proxy's `X-Fabrika-Endpoint` for that row and its digest a 503; then the row's handler. A
 * `protocol` or `health` row ignores the header, because the service authenticates it itself and it also arrives
 * unfronted (ADR-0022 rule 5).
 */
export function serveService<Id extends string, Env>(
	service: ServiceArtifact<Id>,
	handlers: ServiceHandlers<Id, Env>,
	options: ServeServiceOptions<Env> = {},
): FabrikaApp<Env> {
	const table = compileEndpointTable<InstallationEndpointRow & { readonly id: Id }>(service)
	const missing = service.endpoints.filter((row) => !Object.hasOwn(handlers, row.id)).map((row) => row.id)
	if (missing.length > 0) {
		throw new ServiceHandlersError(`service '${service.id}' has no handler for ${missing.map((id) => `'${id}'`).join(', ')}`)
	}
	const digests = new Map(service.endpoints.map((row) => [row.id, requirementDigest({ ...row, delegation: null })]))
	const onError = options.onError ?? defaultOnError

	return {
		async fetch(request, env, exec) {
			const plan = planEndpoint(table, request.method, rawRequestTarget(request.url).pathname)
			if (plan.outcome === 'non-canonical') {
				return jsonResponse({ error: { type: 'bad_request', message: 'The request path is not canonical' } }, 400)
			}
			if (plan.outcome === 'no-endpoint') {
				return jsonResponse({ error: { type: 'not_found', message: 'Not found' } }, 404)
			}
			const row = plan.endpoint
			if (row.kind === 'service' && !namesRow(request.headers.get(ENDPOINT_HEADER), row.id, digests.get(row.id))) {
				console.error(`service '${service.id}': '${row.id}' was reached without the proxy's decision for its rules`)
				return jsonResponse({ error: { type: 'unavailable', message: 'Service unavailable' } }, 503)
			}
			const params = decodeParams(plan.params)
			if (params === null) {
				return jsonResponse({ error: { type: 'bad_request', message: 'A path parameter does not decode' } }, 400)
			}
			try {
				return await handlers[row.id]({ request, params, env, exec })
			} catch (error) {
				return onError(error, request, env)
			}
		},
	}
}

function namesRow(header: string | null, id: string, digest: string | undefined): boolean {
	const named = header === null ? null : parseEndpointHeader(header)
	return named !== null && named.id === id && named.digest === digest
}

function decodeParams(raw: Readonly<Record<string, string>>): Readonly<Record<string, string>> | null {
	const decoded: [string, string][] = []
	for (const [name, value] of Object.entries(raw)) {
		try {
			decoded.push([name, decodeURIComponent(value)])
		} catch {
			return null
		}
	}
	return Object.fromEntries(decoded)
}
