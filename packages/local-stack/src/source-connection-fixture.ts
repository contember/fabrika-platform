import { buildZeropsSourceCredentialBundleV2, serializeZeropsSourceCredentialBundleV2, zeropsSourceCredentialEnvV2 } from '@fabrika/provider-zerops'

const LOCAL_KEYED_GITHUB_CONNECTION_ALPHA = 'local-keyed-alpha'
const LOCAL_KEYED_GITHUB_CONNECTION_BETA = 'local-keyed-beta'
export const LOCAL_KEYED_GITHUB_CONNECTION_IDS = [LOCAL_KEYED_GITHUB_CONNECTION_ALPHA, LOCAL_KEYED_GITHUB_CONNECTION_BETA]

export interface LocalSourceConnectionFixture {
	readonly connectionId: string
	readonly githubAppId: string
	readonly owner: string
	readonly installationId: number
}

export const LOCAL_SOURCE_CONNECTIONS: readonly LocalSourceConnectionFixture[] = [
	{ connectionId: LOCAL_KEYED_GITHUB_CONNECTION_ALPHA, githubAppId: '1002', owner: 'local-alpha', installationId: 10_002 },
	{ connectionId: LOCAL_KEYED_GITHUB_CONNECTION_BETA, githubAppId: '1003', owner: 'local-beta', installationId: 10_003 },
]

export interface LocalSourceCredentialEnvironment extends Record<string, string> {
	FABRIKA_SOURCE_RPC_KEY: string
}

/** Two independent keyed snapshots, so local routing has to select the exact connection. */
export async function localSourceCredentialFixture(
	rpcKey: string,
	privateKeyPem: string,
): Promise<LocalSourceCredentialEnvironment> {
	const env: LocalSourceCredentialEnvironment = { FABRIKA_SOURCE_RPC_KEY: rpcKey }
	for (const connection of LOCAL_SOURCE_CONNECTIONS) {
		const connectionId = connection.connectionId
		env[await zeropsSourceCredentialEnvV2(connectionId)] = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
			connectionId,
			githubAppId: connection.githubAppId,
			privateKeyPem,
		}))
	}
	return env
}
