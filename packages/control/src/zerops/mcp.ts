import { createIam, type Iam } from '@fabrika/auth'
import { controlMcpResource, controlMcpResourceMetadata } from '../../fabrika.service'
import { VOZKA_APP_ID } from '../actions'
import type { McpRoute } from '../app'
import type { Env } from '../env'
import { controlPublicOrigin } from '../iam'
import { createControlMcpHandler } from '../mcp/handler'
import type { WorkspaceSourcePort } from '../workspace-source-port'

/**
 * The MCP endpoint of this installation. The resource URI a token is minted for is derived from the console's public
 * origin, so a console told to serve MCP without one refuses to start.
 */
export function controlMcpRoute(env: Env, source: WorkspaceSourcePort): McpRoute {
	const publicOrigin = controlPublicOrigin(env)
	if (publicOrigin === undefined) throw new Error('MCP authoring is on, but FABRIKA_CONTROL_DOMAIN names no public origin to derive its resource from')
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
