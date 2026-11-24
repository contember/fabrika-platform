import { CONTROL_APP_ID } from '@fabrika/control-contract'
import { IAM_APP_ID } from '@fabrika/iam-contract'
import { type McpClient, parseMcpClientsJson, reconcileIdentityApps } from '@fabrika/installation-init'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import type { PlatformIamTarget } from '../provider'

/** The GitHub Environment variable the operator registers OAuth clients in, the same name as on Zerops. */
export const MCP_CLIENTS_VARIABLE = 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON'

/** A roles reconcile under one of these would rewrite a platform service's vocabulary. */
const PLATFORM_APPS: readonly string[] = [IAM_APP_ID, CONTROL_APP_ID, OPERATIONS_APP_ID]

/**
 * The client list of a Cloudflare installation, parsed once where it enters a stage. Unset or empty registers none.
 * Identity-bound external clients are supported (ADR-0084). MCP authoring is not supported on Cloudflare yet, so any
 * other entry is refused as unsupported; so are an identity app that is a platform service's and an identity resource
 * on one of `platformHosts`. Every refusal comes before the stage deploys anything.
 */
export const parseCloudflareIdentityClients = (raw: string | undefined, platformHosts: readonly string[]): readonly McpClient[] => {
	if (raw === undefined || raw.trim() === '') return []
	let clients: readonly McpClient[]
	try {
		clients = parseMcpClientsJson(raw)
	} catch (error) {
		throw new Error(`${MCP_CLIENTS_VARIABLE}: ${error instanceof Error ? error.message : 'unreadable'}`)
	}
	for (const { clientId, provider, identity } of clients) {
		if (provider !== 'external' || identity === undefined) {
			throw new Error(
				`${MCP_CLIENTS_VARIABLE}: client ${clientId} is not supported on Cloudflare yet. A Cloudflare installation does not `
					+ "support MCP authoring yet; it registers only identity-bound clients { provider: 'external', identity: { app, resource, roles? } }",
			)
		}
		if (PLATFORM_APPS.includes(identity.app)) {
			throw new Error(`${MCP_CLIENTS_VARIABLE}: client ${clientId}: its identity app \`${identity.app}\` is a platform service's`)
		}
		if (platformHosts.includes(new URL(identity.resource).hostname)) {
			throw new Error(`${MCP_CLIENTS_VARIABLE}: client ${clientId}: its identity resource is on a platform service's host`)
		}
	}
	return clients
}

export interface IdentityAppsRegistration {
	/** IAM's origin and the provisioning key the stage holds; absent when the stage names neither. */
	readonly iam: PlatformIamTarget | undefined
	readonly clients: readonly McpClient[]
	readonly dryRun: boolean
	readonly reconcile: SchemaReconciler
}

/** Reconcile each external application's declared roles into IAM, after IAM's own vocabulary (ADR-0084). */
export const registerIdentityApps = async ({ iam, clients, dryRun, reconcile }: IdentityAppsRegistration): Promise<void> => {
	if (clients.length === 0) return
	if (iam === undefined && !dryRun) {
		throw new Error(`reconciling the roles of ${MCP_CLIENTS_VARIABLE} needs FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY`)
	}
	await reconcileIdentityApps({
		clients,
		// A dry run writes nothing, so it needs neither.
		url: iam?.url ?? '',
		adminKey: iam?.adminKey ?? '',
		dryRun,
		signal: new AbortController().signal,
		reconcile,
		info: (message) => console.info(message),
	})
}
