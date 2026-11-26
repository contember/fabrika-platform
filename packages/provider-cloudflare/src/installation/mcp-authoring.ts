import { MCP_AUTHORING_VARIABLE, parseMcpAuthoring, readEnv } from '@fabrika/installation-init'

/**
 * The MCP authoring switch (ADR-0089 §4) of a Cloudflare installation, read where it enters a stage. MCP authoring is
 * not supported on Cloudflare yet, so `on` is refused. The change that adds it (open PRs #408 and #409; whichever lands
 * second) wires the switch into the composition here.
 */
export const assertCloudflareMcpAuthoringOff = (env: Readonly<Record<string, string | undefined>>): void => {
	if (parseMcpAuthoring(readEnv(env, MCP_AUTHORING_VARIABLE), MCP_AUTHORING_VARIABLE) === true) {
		throw new Error(`${MCP_AUTHORING_VARIABLE}=on: a Cloudflare installation does not support MCP authoring yet`)
	}
}
