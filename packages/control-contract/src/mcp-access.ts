// What an MCP client may ask IAM for on an installation's console (ADR-0049): one OAuth resource, the console's `/mcp`,
// under the one scope `authoring`. Every provider registers it from here when MCP authoring is on, so they cannot drift.

import { CONTROL_ACTIONS } from './access.js'

/** The MCP endpoint's path on the console origin, and the one OAuth scope a client asks for. */
export const CONTROL_MCP_PATH = '/mcp'
export const CONTROL_MCP_SCOPE = 'authoring'

/** The console's MCP endpoint as an OAuth resource: its path, its scope (also its default) and what that scope grants. */
export interface ControlMcpResource {
	readonly path: typeof CONTROL_MCP_PATH
	readonly scope: typeof CONTROL_MCP_SCOPE
	readonly actions: readonly string[]
}

/** `authoring` grants only what the MCP tools call; IAM still narrows it by the person's own grants. */
export const CONTROL_MCP_RESOURCE: ControlMcpResource = {
	path: CONTROL_MCP_PATH,
	scope: CONTROL_MCP_SCOPE,
	actions: [
		CONTROL_ACTIONS.SOURCE_WORKSPACE_READ,
		CONTROL_ACTIONS.SOURCE_WORKSPACE_WRITE,
		CONTROL_ACTIONS.SOURCE_PULL_REQUEST_CREATE,
		CONTROL_ACTIONS.DEPLOY_TRIGGER,
		CONTROL_ACTIONS.DEPLOY_READ,
	],
}
