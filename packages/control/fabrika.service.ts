// The control plane's service contract (ADR-0022 "Installation entries"): the endpoint table its proxy decides from
// and `controlApp` serves.
//
// This module stays free of `@fabrika/provider-cloudflare` and of `src/` beyond the action constants: this package
// relaxes two strict flags for oblaka, and strict consumers import this file.

import { defineServiceContract } from '@fabrika/app/service'
import { type BodyAdmission, FABRIKA_SERVICE_TABLE_DIGEST, installationTableDigest } from '@fabrika/auth-core'
import { VOZKA_APP_ID } from './src/actions'

/** The MCP endpoint path on the console origin, and the one OAuth scope a client asks for. */
export const CONTROL_MCP_PATH = '/mcp'
export const CONTROL_MCP_SCOPE = 'authoring'

/** RFC 8707 resource URI of the MCP endpoint for a console public origin (no trailing slash). */
export function controlMcpResource(publicOrigin: string): string {
	return `${publicOrigin}${CONTROL_MCP_PATH}`
}

/** RFC 9728 metadata URL the proxy serves for that resource. */
export function controlMcpResourceMetadata(publicOrigin: string): string {
	return `${publicOrigin}/.well-known/oauth-protected-resource${CONTROL_MCP_PATH}`
}

const JSON_BODY: BodyAdmission = { contentTypes: ['application/json'], maxBytes: null }

export interface ControlServiceOptions {
	/** Whether MCP authoring is served: the proxy has an authorization server and the service an MCP route. */
	readonly mcp: boolean
}

export type ControlEndpointId = ReturnType<typeof controlServiceContract>['endpoints'][number]['id']

/**
 * The console's rows. `*-root` rows are the exact paths of the reserved prefixes: the service answers 404 there, so
 * neither they nor `/mcp` reach the SPA. With MCP off, `/mcp` is such a row for a session, as its gate was.
 */
export function controlServiceContract(options: ControlServiceOptions) {
	return defineServiceContract(VOZKA_APP_ID, (s) => ({
		endpoints: {
			'health': s.health('*', '/healthz'),
			'api-health': s.health('*', '/api/health'),
			'builder-discovery': s.protocol('*', '/.well-known/fabrika-builder'),
			'builder-connect': s.protocol('*', '/builder/connect'),
			'github-webhook': s.protocol('POST', '/webhooks/github/:connectionId'),
			'webhooks-root': s.service('*', '/webhooks', { callers: ['human'] }),
			'github-manifest': s.service('GET', '/api/source/github/manifest/:connectionId', { callers: ['human'] }),
			'github-callback': s.service('GET', '/api/source/github/callback', { callers: ['human'] }),
			'rpc': s.service('POST', '/api/rpc', { callers: ['human', 'machine'], admission: JSON_BODY }),
			'api-root': s.service('*', '/api', { callers: ['human'] }),
			'iam-admin-rpc': s.service('POST', '/iam/admin/rpc', { callers: ['human', 'machine'], admission: JSON_BODY }),
			'iam-admin-root': s.service('*', '/iam/admin', { callers: ['human', 'machine'] }),
			'operations-rpc': s.service('POST', '/operations/api/rpc', { callers: ['human', 'machine'], admission: JSON_BODY }),
			'operations-api-root': s.service('*', '/operations/api', { callers: ['human', 'machine'] }),
			'console': s.service('GET', '/*', { callers: ['human'] }),
			'mcp': options.mcp
				? s.service('*', CONTROL_MCP_PATH, { callers: ['oauth'], scopes: [CONTROL_MCP_SCOPE] })
				: s.service('*', CONTROL_MCP_PATH, { callers: ['human'] }),
		},
		reservedPrefixes: ['/api', '/iam/admin', '/operations/api', '/webhooks', CONTROL_MCP_PATH],
	}))
}

/** `installationTableDigest` of one console table: what a composition writes as `FABRIKA_SERVICE_TABLE_DIGEST`. */
export function controlServiceDigest(options: ControlServiceOptions): string {
	return installationTableDigest(controlServiceContract(options))
}

export class ControlTableError extends Error {
	override readonly name = 'ControlTableError'
}

/**
 * Whether this console serves MCP, read from the digest of the table its proxy publishes: the one switch, so the
 * service cannot serve one table while its proxy decides from the other. A missing digest or one that names neither
 * table refuses to start rather than answering 503 at runtime.
 */
export function controlMcpSwitch(digest: string | undefined): boolean {
	if (digest === undefined || digest.trim() === '') {
		throw new ControlTableError(
			`${FABRIKA_SERVICE_TABLE_DIGEST} is not set; the composition writes the digest of the table the console's proxy publishes`,
		)
	}
	if (digest === controlServiceDigest({ mcp: true })) return true
	if (digest === controlServiceDigest({ mcp: false })) return false
	throw new ControlTableError(`${FABRIKA_SERVICE_TABLE_DIGEST} names no console table this version serves; its proxy publishes another`)
}
