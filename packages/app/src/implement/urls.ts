// `ctx.url('<endpoint id>', { input?, query? })`: an absolute link to one of the application's own procedures, for a
// mail, a redirect or an answer. The origin is the environment's canonical one (`FABRIKA_APP_ORIGIN`, which a deploy
// writes), the path the endpoint's, and the parameters what its HTTP shape reads from the URL: the input of a `GET`,
// the `query` of a `POST`. Each value is spelled as the procedure reads it back (`params.ts`).

import { type ContractArtifact, type EndpointRow, FABRIKA_APP_ORIGIN } from '@fabrika/auth-core'
import { ServerFault } from './faults'

/** A value a URL parameter carries; an absent one is left out. */
export type UrlValue = string | number | boolean | null | undefined

export interface UrlParameters {
	/** A `GET` procedure's input, each field a parameter. */
	readonly input?: Readonly<Record<string, UrlValue>>
	/** A `POST` procedure's `http.query`. */
	readonly query?: Readonly<Record<string, UrlValue>>
}

/** `ctx.url`: the absolute URL of a procedure of this contract, with the parameters its HTTP shape reads from the URL. */
export type AppUrl = (endpoint: string, parameters?: UrlParameters) => string

/** The environment's canonical origin, or `null` where the deploy wrote none; a malformed one is a boot problem. */
export function readAppOrigin(framework: Readonly<Record<string, string>>, problems: string[]): string | null {
	const value = framework[FABRIKA_APP_ORIGIN]?.trim() ?? ''
	if (value === '') {
		return null
	}
	try {
		const url = new URL(value)
		if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value) {
			return value
		}
	} catch {
		// Reported below, as every other malformed value.
	}
	problems.push(`${FABRIKA_APP_ORIGIN} '${value}' is not an origin (allowed: https://<host>)`)
	return null
}

/** `ctx.url` over the approved artifact's procedure rows. */
export function appUrl(artifact: ContractArtifact, origin: string | null): AppUrl {
	const procedures = new Map(artifact.endpoints.filter(isProcedureRow).map((row) => [row.id, row]))
	return (endpoint, parameters = {}) => {
		const row = procedures.get(endpoint)
		if (row === undefined) {
			throw new ServerFault('url_unbuildable', `ctx.url names '${String(endpoint)}', which is no procedure of the contract`)
		}
		if (origin === null) {
			throw new ServerFault('url_unbuildable', `ctx.url needs ${FABRIKA_APP_ORIGIN}, and the environment has no public origin`)
		}
		const reads = row.method === 'GET' ? 'input' : 'query'
		const other = reads === 'input' ? parameters.query : parameters.input
		const hasQuery = artifact.procedures?.[endpoint]?.query !== undefined
		if (other !== undefined || (reads === 'query' && parameters.query !== undefined && !hasQuery)) {
			throw new ServerFault(
				'url_unbuildable',
				`ctx.url('${endpoint}') passes parameters its HTTP shape does not read from the URL (allowed: ${
					reads === 'input' ? 'input of a GET' : 'query of a POST that declares http.query'
				})`,
			)
		}
		const search = new URLSearchParams()
		for (const [name, value] of Object.entries(parameters[reads] ?? {})) {
			if (value === undefined) continue
			if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
				throw new ServerFault('url_unbuildable', `ctx.url('${endpoint}') parameter '${name}' is no scalar`)
			}
			search.set(name, value === null ? 'null' : String(value))
		}
		const text = search.toString()
		return `${origin}${row.path}${text === '' ? '' : `?${text}`}`
	}
}

/** A row a procedure of an RPC or link mount answers: never a generated, file or platform row. */
function isProcedureRow(row: EndpointRow): boolean {
	return (row.kind === 'query' || row.kind === 'mutation' || row.kind === 'public') && row.source.kind === 'mount'
}
