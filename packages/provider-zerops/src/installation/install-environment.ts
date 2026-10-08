import { encodeProxyManifestJson, FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'
import type { ZeropsNamespaceProxySource } from '../index'
import type { PlatformDeployService, ResolvedService } from './deploy'
import { type PlatformHosts, platformOrigin } from './hosts'
import { assertRunning, type InstallCollaborators } from './install-collaborators'
import { FABRIKA_ZEROPS_PROXY_SOURCE_JSON, serializeNamespaceProxySource } from './installation-source'
import type { InstallationSecrets } from './secrets'

/** The private address the proxy dials IAM at inside the project, and pass 1's placeholder issuer. */
export const PRIVATE_IAM_UPSTREAM = 'iam:3000'
const PRIVATE_IAM_URL = `http://${PRIVATE_IAM_UPSTREAM}`

/** The canonical fabrika PostgreSQL DSN on Zerops — see `src/topology/setups.ts` for why both suffixes exist. */
const POSTGRES_URL = '${db_connectionTlsString}/${db_dbName}?sslmode=require'

/** The light tier's one object-storage service, as the platform's own `${service_variable}` references. */
const STORAGE = {
	bucket: '${storage_bucketName}',
	accessKeyId: '${storage_accessKeyId}',
	secretAccessKey: '${storage_secretAccessKey}',
	endpoint: '${storage_apiUrl}',
} as const

/**
 * The four variables pass 1 writes on the proxy, and nothing else.
 *
 * The manifest is EMPTY on purpose: it is the only legal document that can be written before the hosts
 * exist, and the build bakes whatever is here (`src/topology/setups.ts`). `FABRIKA_IAM_ISSUER` is the private
 * address rather than the public issuer for the same reason — the public one is not known yet — and
 * `deployPlatform` corrects it in pass 2, before the manifest it belongs to is applied.
 */
export const passOneProxyEnv = (secrets: InstallationSecrets): ReadonlyMap<string, string> =>
	new Map([
		[FABRIKA_PROXY_MANIFEST_JSON, encodeProxyManifestJson({ apps: [] })],
		['FABRIKA_IAM_ISSUER', PRIVATE_IAM_URL],
		['FABRIKA_IAM_KEY', secrets.proxyKey],
		['FABRIKA_PROXY_SESSION_OWNER_JSON', 'null'],
	])

/** What `installationServiceEnv` needs. Everything in it is settled before the first write. */
export interface InstallationEnvInput {
	readonly environment: string
	readonly scheme: 'http' | 'https'
	readonly hosts: PlatformHosts
	readonly clientId: string
	readonly proxySource: ZeropsNamespaceProxySource
	readonly apiBaseUrl?: string
	readonly secrets: InstallationSecrets
	/** The Zerops integration token minted for the control plane. Never logged, never printed. */
	readonly zeropsAccessToken: string
}

/**
 * EVERY variable this command places, per service.
 *
 * Pure, and exported, because the matrix is the thing most worth pinning: a name that is right on
 * Cloudflare and wrong on Bun is a silent no-op rather than a failure. Two spelling rules run through
 * it, both verified against the runtimes rather than assumed:
 *
 *   • IAM's Bun runtime reads `ISSUER` and `ENVIRONMENT` UNPREFIXED and everything else with the
 *     `FABRIKA_IAM_` prefix (`packages/iam/src/node/runtime.ts`). The prefixed spellings below are the
 *     ones that file actually reads; the unprefixed ones are the ones it actually reads too.
 *   • No key any service declares in its own `zerops.yaml` appears here — `PORT`,
 *     `FABRIKA_IAM_RPC_URL`, `FABRIKA_OPERATIONS_URL`, `FABRIKA_CONTROL_ASSETS_DIR`,
 *     `FABRIKA_CONTROL_URL`, `FABRIKA_PROXY_MANIFEST`, `FABRIKA_PROXY_PORT`. The env API refuses those
 *     (`provider-zerops/src/api.ts`), because the conflict cannot be resolved to a record id.
 *
 * The proxy manifest is deliberately absent: pass 1 writes an empty one and `deployPlatform` owns the
 * real one, in the same run as the code it describes (ADR-0027).
 */
export const installationServiceEnv = (input: InstallationEnvInput): ReadonlyMap<PlatformDeployService, ReadonlyMap<string, string>> => {
	const { secrets } = input
	const iamOrigin = platformOrigin(input.scheme, input.hosts.iam)
	const operationsOrigin = platformOrigin(input.scheme, input.hosts.operations)
	const control = new Map([
		['FABRIKA_CONTROL_DATABASE_URL', POSTGRES_URL],
		['ENVIRONMENT', input.environment],
		// A bare HOST, not an origin: `controlPublicOrigin` accepts either, and this is also what the
		// same-origin check on both first-party gateways is decided against.
		['FABRIKA_CONTROL_DOMAIN', input.hosts.control],
		['FABRIKA_IAM_ISSUER', iamOrigin],
		['OPERATIONS_ARTIFACT_ORIGIN', operationsOrigin],
		['FABRIKA_CONTROL_RUN_LOGS_BUCKET', STORAGE.bucket],
		['FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID', STORAGE.accessKeyId],
		['FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY', STORAGE.secretAccessKey],
		['FABRIKA_CONTROL_RUN_LOGS_ENDPOINT', STORAGE.endpoint],
		['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
		['OPERATIONS_SYNC_KEY', secrets.operationsSyncKey],
		['FABRIKA_CONTROL_VAULT_KEY', secrets.vaultKey],
		['FABRIKA_IAM_PROVISIONING_KEY', secrets.provisioningKey],
		['FABRIKA_ZEROPS_CLIENT_ID', input.clientId],
		[FABRIKA_ZEROPS_PROXY_SOURCE_JSON, serializeNamespaceProxySource(input.proxySource)],
		// The PUBLIC IAM origin an application project's proxy reaches: there is no private network
		// between Zerops projects (ADR-0006).
		['FABRIKA_ZEROPS_PROXY_IAM_URL', iamOrigin],
		['FABRIKA_ZEROPS_PROXY_IAM_KEY', secrets.proxyKey],
		['FABRIKA_ZEROPS_ACCESS_TOKEN', input.zeropsAccessToken],
	])
	if (input.apiBaseUrl !== undefined) {
		// Only when the installation is not on the default region. Control spells it `_API_BASE_URL` while
		// the CLI reads `FABRIKA_ZEROPS_API_URL`; they are different processes reading different sources.
		control.set('FABRIKA_ZEROPS_API_BASE_URL', input.apiBaseUrl)
	}
	return new Map<PlatformDeployService, ReadonlyMap<string, string>>([
		[
			'iam',
			new Map([
				['FABRIKA_IAM_DATABASE_URL', POSTGRES_URL],
				['ENVIRONMENT', input.environment],
				['ISSUER', iamOrigin],
				// Password only, by decision: OIDC needs an identity provider the operator has not been
				// asked for. Both are STATED because IAM's own defaults are the other way round — OIDC on,
				// password off — and it refuses to boot with neither.
				['FABRIKA_IAM_OIDC_ENABLED', 'false'],
				['FABRIKA_IAM_PASSWORD_ENABLED', 'true'],
				['FABRIKA_IAM_SIGNING_KEYS', secrets.signingKeys],
				['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
				['FABRIKA_IAM_PROXY_KEY', secrets.proxyKey],
				['FABRIKA_IAM_PROVISIONING_KEY', secrets.provisioningKey],
			]),
		],
		[
			'operations',
			new Map([
				['FABRIKA_OPERATIONS_DATABASE_URL', POSTGRES_URL],
				['FABRIKA_OPERATIONS_BLOB_BUCKET', STORAGE.bucket],
				['FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID', STORAGE.accessKeyId],
				['FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY', STORAGE.secretAccessKey],
				['FABRIKA_OPERATIONS_BLOB_ENDPOINT', STORAGE.endpoint],
				['FABRIKA_OPERATIONS_PUBLIC_HOST', input.hosts.operations],
				['ENVIRONMENT', input.environment],
				['FABRIKA_IAM_ISSUER', iamOrigin],
				['OPERATIONS_SYNC_KEY', secrets.operationsSyncKey],
				['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
			]),
		],
		['control', control],
		[
			'proxy',
			new Map([
				['ENVIRONMENT', input.environment],
				// Compared byte-for-byte against a token's `iss`, so this is the PUBLIC issuer and not the
				// private `iam:3000` pass 1 wrote.
				['FABRIKA_IAM_ISSUER', iamOrigin],
				['FABRIKA_IAM_KEY', secrets.proxyKey],
				['FABRIKA_PROXY_SESSION_OWNER_JSON', JSON.stringify({ issuer: iamOrigin, upstream: PRIVATE_IAM_UPSTREAM })],
			]),
		],
	])
}

/**
 * The keys whose VALUE this command generates, per service.
 *
 * Their presence on a live service is what "this project already holds an installation" means, and it is
 * checked by KEY only — a value is never read back for comparison. `__tests__/install.test.ts` pins this
 * against the matrix above, so a new generated secret cannot be added without appearing here.
 */
export const GENERATED_SECRET_KEYS: ReadonlyMap<PlatformDeployService, readonly string[]> = new Map<PlatformDeployService, readonly string[]>([
	['iam', ['FABRIKA_IAM_SIGNING_KEYS', 'FABRIKA_IAM_RPC_KEY', 'FABRIKA_IAM_PROXY_KEY', 'FABRIKA_IAM_PROVISIONING_KEY']],
	['operations', ['OPERATIONS_SYNC_KEY', 'FABRIKA_IAM_RPC_KEY']],
	[
		'control',
		[
			'FABRIKA_IAM_RPC_KEY',
			'OPERATIONS_SYNC_KEY',
			'FABRIKA_CONTROL_VAULT_KEY',
			'FABRIKA_IAM_PROVISIONING_KEY',
			'FABRIKA_ZEROPS_PROXY_IAM_KEY',
			'FABRIKA_ZEROPS_ACCESS_TOKEN',
		],
	],
	['proxy', ['FABRIKA_IAM_KEY']],
])

/**
 * Write a set of variables, reporting the KEYS — never a value, not even in a debug line.
 *
 * Write-first and unconditional: half of these are generated secrets, and a read-compare-write over a
 * value the platform may or may not hand back verbatim would make the outcome depend on something
 * nobody has pinned. `PUT /user-data/{id}` replaces in place, so a repeat costs a call and nothing else.
 */
export const writeServiceEnv = async (
	service: ResolvedService,
	desired: ReadonlyMap<string, string>,
	{ api, log, signal }: InstallCollaborators,
): Promise<void> => {
	for (const [key, value] of desired) {
		assertRunning(signal)
		await api.putServiceEnv({ serviceId: service.id, key, value, signal })
	}
	log.ok(`${service.hostname}: wrote ${[...desired.keys()].join(', ')}`)
}
