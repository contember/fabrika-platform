import {
	buildZeropsSourceCredentialBundle,
	buildZeropsSourceCredentialBundleV2,
	serializeZeropsSourceCredentialBundle,
	serializeZeropsSourceCredentialBundleV2,
	zeropsSourceCredentialEnvV2,
} from '@fabrika/provider-zerops'

export const LOCAL_LEGACY_GITHUB_APP_ID = '1001'
const LOCAL_KEYED_GITHUB_CONNECTION_ALPHA = 'local-keyed-alpha'
const LOCAL_KEYED_GITHUB_CONNECTION_BETA = 'local-keyed-beta'
export const LOCAL_KEYED_GITHUB_CONNECTION_IDS = [LOCAL_KEYED_GITHUB_CONNECTION_ALPHA, LOCAL_KEYED_GITHUB_CONNECTION_BETA]

export interface LocalSourceConnectionFixture {
	readonly connectionId: string
	readonly transportKind: 'legacy-v1' | 'keyed-v2'
	readonly githubAppId: string
	readonly owner: string
	readonly installationId: number
}

export const LOCAL_SOURCE_CONNECTIONS: readonly LocalSourceConnectionFixture[] = [
	{ connectionId: 'local-legacy', transportKind: 'legacy-v1', githubAppId: LOCAL_LEGACY_GITHUB_APP_ID, owner: 'local-legacy', installationId: 10_001 },
	{ connectionId: LOCAL_KEYED_GITHUB_CONNECTION_ALPHA, transportKind: 'keyed-v2', githubAppId: '1002', owner: 'local-alpha', installationId: 10_002 },
	{ connectionId: LOCAL_KEYED_GITHUB_CONNECTION_BETA, transportKind: 'keyed-v2', githubAppId: '1003', owner: 'local-beta', installationId: 10_003 },
]

export interface LocalSourceCredentialEnvironment extends Record<string, string> {
	FABRIKA_SOURCE_RPC_KEY: string
	GITHUB_APP_CREDENTIALS: string
}

/** One legacy snapshot plus two independent keyed snapshots for local routing witnesses. */
export async function localSourceCredentialFixture(
	rpcKey: string,
	privateKeyPem: string,
): Promise<LocalSourceCredentialEnvironment> {
	const env: LocalSourceCredentialEnvironment = {
		FABRIKA_SOURCE_RPC_KEY: rpcKey,
		GITHUB_APP_CREDENTIALS: serializeZeropsSourceCredentialBundle(buildZeropsSourceCredentialBundle({
			githubAppId: LOCAL_LEGACY_GITHUB_APP_ID,
			privateKeyPem,
		})),
	}
	for (const connection of LOCAL_SOURCE_CONNECTIONS) {
		if (connection.transportKind !== 'keyed-v2') continue
		const connectionId = connection.connectionId
		env[await zeropsSourceCredentialEnvV2(connectionId)] = serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
			connectionId,
			githubAppId: connection.githubAppId,
			privateKeyPem,
		}))
	}
	return env
}
