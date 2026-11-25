// Whether a Cloudflare installation serves MCP authoring (ADR-0049 rule 9), from the operator's client list.

import { mcpAuthoringOn } from '@fabrika/installation-init'
import { MCP_CLIENTS_VARIABLE, parseCloudflareIdentityClients } from './identity-clients'

type EnvironmentSource = Readonly<Record<string, string | undefined>>

/** The hostnames of the console, IAM and Operations a stage names; an identity resource may be on none of them. */
export const cloudflarePlatformHosts = (source: EnvironmentSource): string[] => {
	const hosts: string[] = []
	const control = source['FABRIKA_CONTROL_DOMAIN']
	if (control !== undefined && control !== '') hosts.push(control)
	for (const origin of [source['FABRIKA_IAM_ISSUER'], source['OPERATIONS_ARTIFACT_ORIGIN']]) {
		if (origin !== undefined && URL.canParse(origin)) hosts.push(new URL(origin).hostname)
	}
	return hosts
}

/**
 * MCP authoring is on when `FABRIKA_PLATFORM_MCP_CLIENTS_JSON` registers a client that is not identity-only, as on
 * Zerops. Control's config derives the console's table from it, so the proxy publishes `/mcp` exactly when IAM is
 * handed a client for it. The list is parsed as the platform stage parses it: a list the installation refuses stops this
 * deploy too.
 */
export const cloudflareMcpAuthoringOn = (source: EnvironmentSource): boolean =>
	mcpAuthoringOn(parseCloudflareIdentityClients(source[MCP_CLIENTS_VARIABLE], cloudflarePlatformHosts(source)))
