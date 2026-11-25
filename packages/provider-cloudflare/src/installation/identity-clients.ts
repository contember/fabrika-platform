import { CONTROL_APP_ID } from '@fabrika/control-contract'
import { IAM_APP_ID } from '@fabrika/iam-contract'
import {
	createIamAdminClient,
	type IamAdminConnection,
	importOAuthClientsOnce,
	MCP_AUTHORING_VARIABLE,
	type McpClient,
	type OAuthClientImportApi,
	parseMcpAuthoring,
	parseMcpClientsJson,
	readEnv,
} from '@fabrika/installation-init'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import type { PlatformIamTarget } from '../provider'

/** The GitHub Environment variable the operator registered OAuth clients in, the same name as on Zerops. */
export const MCP_CLIENTS_VARIABLE = 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON'

/** IAM's own vocabulary and every platform service's: no external application may take one. */
const PLATFORM_APPS: readonly string[] = [IAM_APP_ID, CONTROL_APP_ID, OPERATIONS_APP_ID]

/**
 * The client list of a Cloudflare installation, parsed once where it enters a stage; absent when unset or empty.
 * Identity-bound external clients are supported (ADR-0084). MCP authoring is not supported on Cloudflare yet, so any
 * other entry is refused as unsupported; so are an identity app that is a platform service's and an identity resource
 * on one of `platformHosts`. Every refusal comes before the stage deploys anything.
 */
export const parseCloudflareIdentityClients = (
	raw: string | undefined,
	platformHosts: readonly string[],
): readonly McpClient[] | undefined => {
	if (raw === undefined || raw.trim() === '') return undefined
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

/**
 * The MCP authoring switch (ADR-0089 §4) of a Cloudflare installation, read where it enters a stage. MCP authoring is
 * not supported on Cloudflare yet, so `on` is refused like an authoring entry in the client list. The change that adds
 * it (open PRs #408 and #409; whichever lands second) wires the switch into the composition here.
 */
export const assertCloudflareMcpAuthoringOff = (env: Readonly<Record<string, string | undefined>>): void => {
	if (parseMcpAuthoring(readEnv(env, MCP_AUTHORING_VARIABLE), MCP_AUTHORING_VARIABLE) === true) {
		throw new Error(`${MCP_AUTHORING_VARIABLE}=on: a Cloudflare installation does not support MCP authoring yet`)
	}
}

export interface OAuthClientsImport {
	/** IAM's origin and the provisioning key the stage holds; absent when the stage names neither. */
	readonly iam: PlatformIamTarget | undefined
	/** The parsed client list; absent when the variable is unset. */
	readonly clients: readonly McpClient[] | undefined
	readonly dryRun: boolean
	/** IAM's admin surface; the real client unless a test stands one in. */
	readonly connect?: (connection: IamAdminConnection) => OAuthClientImportApi
}

/** Import the client list into IAM's registry once, after IAM's own vocabulary; it replaces the roles reconcile (ADR-0089). */
export const importCloudflareOAuthClients = async ({ iam, clients, dryRun, connect = createIamAdminClient }: OAuthClientsImport): Promise<void> => {
	await importOAuthClientsOnce({
		clients,
		variable: MCP_CLIENTS_VARIABLE,
		dryRun,
		connect: () => {
			if (iam === undefined) {
				throw new Error('importing the OAuth client list into IAM needs FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY')
			}
			return connect({ origin: iam.url, provisioningKey: iam.adminKey })
		},
		log: { info: (message) => console.info(message), warn: (message) => console.warn(message) },
	})
}
