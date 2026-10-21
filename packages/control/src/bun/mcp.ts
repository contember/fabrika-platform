import { createIam, type Iam } from '@fabrika/auth'
import { CONTROL_APP_ID } from '@fabrika/control-contract'
import type { ControlProvider } from '@fabrika/provider-contract'
import { controlMcpResource, controlMcpResourceMetadata } from '../../fabrika.service'
import { ControlApiError } from '../api/domain'
import type { McpRoute } from '../app'
import type { Env } from '../env'
import { controlPublicOrigin } from '../iam'
import { createControlMcpHandler } from '../mcp/handler'
import type { WorkspaceSourcePort } from '../workspace-source-port'

/**
 * The MCP endpoint of this installation. The resource URI a token is minted for is derived from the console's public
 * origin, so a console told to serve MCP without one refuses to start.
 */
export function controlMcpRoute(env: Env, source: WorkspaceSourcePort, provider: ControlProvider): McpRoute {
	if (provider.authoring === undefined) throw new Error(`MCP authoring is on, but the ${provider.id} provider supports no authoring target`)
	const { protectedFiles } = provider.authoring
	const publicOrigin = controlPublicOrigin(env)
	if (publicOrigin === undefined) throw new Error('MCP authoring is on, but FABRIKA_CONTROL_DOMAIN names no public origin to derive its resource from')
	const resource = controlMcpResource(publicOrigin)
	let iam: Iam | undefined
	return createControlMcpHandler({
		authenticate: (request) => {
			iam ??= createIam(env, { appId: CONTROL_APP_ID, tokenAudience: { kind: 'resource', app: CONTROL_APP_ID, resource } })
			return iam.authenticate(request)
		},
		resourceMetadata: controlMcpResourceMetadata(publicOrigin),
		useCases: (auth, signal) => ({
			repositories: env.REPOSITORIES,
			source,
			queue: {
				send: (message) =>
					namedFailure(
						() => env.DEPLOY_QUEUE.send(message),
						'Control created the run but could not queue it: the deploy queue is unavailable. Retry deploy_stage in a minute',
					),
			},
			logs: { get: (key) => namedFailure(() => env.RUN_LOGS.get(key), 'The run log store is unavailable. Retry in a minute') },
			auth,
			signal,
			consoleOrigin: publicOrigin,
			protectedFiles,
		}),
	})
}

/** A failed queue or log-store call becomes a short tool error that names the store and says a retry may help. */
async function namedFailure<T>(operation: () => Promise<T>, message: string): Promise<T> {
	try {
		return await operation()
	} catch {
		console.error('mcp: a deploy queue or run log store call failed')
		throw new ControlApiError(503, `${message}; if it keeps failing, tell the operator.`)
	}
}
