import { createIam, type Iam } from '@fabrika/auth'
import { CONTROL_MCP_PATH, controlMcpResource, controlMcpResourceMetadata } from '../../fabrika.gates'
import { VOZKA_APP_ID } from '../actions'
import type { Env } from '../env'
import { controlPublicOrigin } from '../iam'
import { createControlMcpHandler } from '../mcp/handler'
import type { WorkspaceSourcePort } from '../workspace-source-port'

export type McpRoute = (request: Request) => Promise<Response>

/**
 * The MCP endpoint of this installation, or null when no console public origin is configured: the
 * resource URI a token is minted for is derived from that origin, so without it no token can match.
 */
export function controlMcpRoute(env: Env, source: WorkspaceSourcePort): McpRoute | null {
	const publicOrigin = controlPublicOrigin(env)
	if (publicOrigin === undefined) return null
	const resource = controlMcpResource(publicOrigin)
	let iam: Iam | undefined
	return createControlMcpHandler({
		authenticate: (request) => {
			iam ??= createIam(env, { appId: VOZKA_APP_ID, tokenAudience: { kind: 'resource', app: VOZKA_APP_ID, resource } })
			return iam.authenticate(request)
		},
		resourceMetadata: controlMcpResourceMetadata(publicOrigin),
		useCases: (auth, signal) => ({
			repositories: env.REPOSITORIES,
			source,
			queue: env.DEPLOY_QUEUE,
			logs: env.RUN_LOGS,
			auth,
			signal,
			consoleOrigin: publicOrigin,
		}),
	})
}

/** True for the methods Streamable HTTP uses on the MCP path, as the router normalizes the path. */
export function isMcpRequest(request: Request): boolean {
	const path = `/${new URL(request.url).pathname.split('/').filter((segment) => segment !== '').join('/')}`
	return path === CONTROL_MCP_PATH && (request.method === 'POST' || request.method === 'GET' || request.method === 'DELETE')
}
