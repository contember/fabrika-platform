import {
	INSTALLATION_SECRET_VARIABLES,
	type InstallationEmail,
	type InstallationSecrets,
	installationServiceEnvironment,
	type PlatformHosts,
	platformOrigin,
	type PlatformStorage,
} from '@fabrika/installation-init'
import { encodeProxyManifestJson } from '@fabrika/proxy-core/manifest'
import type { ZeropsNamespaceProxySource } from '../index'
import type { PlatformDeployService, ResolvedService } from './deploy'
import { assertRunning, type InstallCollaborators } from './install-collaborators'
import { FABRIKA_ZEROPS_PROXY_SOURCE_JSON, serializeNamespaceProxySource } from './installation-source'
import type { PlatformTier } from './topology/topology'

/** The private address the proxy dials IAM at inside the project, and pass 1's placeholder issuer. */
export const PRIVATE_IAM_UPSTREAM = 'iam:3000'
const PRIVATE_IAM_URL = `http://${PRIVATE_IAM_UPSTREAM}`

/** The canonical fabrika PostgreSQL DSN on Zerops — see `src/topology/setups.ts` for why both suffixes exist. */
const postgresUrl = (service: string): string => `\${${service}_connectionTlsString}/\${${service}_dbName}?sslmode=require`

/** An object-storage service's coordinates, as the platform's own `${service_variable}` references. */
const storageOf = (service: string): PlatformStorage => ({
	bucket: `\${${service}_bucketName}`,
	accessKeyId: `\${${service}_accessKeyId}`,
	secretAccessKey: `\${${service}_secretAccessKey}`,
	endpoint: `\${${service}_apiUrl}`,
})

/** IAM and control share `db` and `storage` on both tiers; Operations has its own database on both, and its own bucket on `standard`. */
const OPERATIONS_DATA: Readonly<Record<PlatformTier, { readonly database: string; readonly storage: string }>> = {
	light: { database: 'operationsdb', storage: 'storage' },
	standard: { database: 'operationsdb', storage: 'operationsstorage' },
}

/**
 * The three variables pass 1 writes on the proxy, and nothing else.
 *
 * `FABRIKA_IAM_ISSUER` is the private address rather than the public issuer because the public one is not known
 * yet; `deployPlatform` corrects it in pass 2, before the manifest it belongs to is applied. The pass-1 manifest is
 * `PASS_ONE_PROXY_MANIFEST`, which the proxy's archive carries.
 */
export const passOneProxyEnv = (secrets: InstallationSecrets): ReadonlyMap<string, string> =>
	new Map([
		['FABRIKA_IAM_ISSUER', PRIVATE_IAM_URL],
		['FABRIKA_IAM_KEY', secrets.proxyKey],
		['FABRIKA_PROXY_SESSION_OWNER_JSON', 'null'],
	])

/** EMPTY on purpose: the only legal document before the hosts exist. The proxy comes up answering 404. */
export const PASS_ONE_PROXY_MANIFEST = encodeProxyManifestJson({ apps: [] })

/** What `installationServiceEnv` needs. Everything in it is settled before the first write. */
export interface InstallationEnvInput {
	readonly environment: string
	/** The installation's own Zerops project, which no deployment namespace may adopt. */
	readonly projectId: string
	readonly tier: PlatformTier
	readonly scheme: 'http' | 'https'
	readonly hosts: PlatformHosts
	readonly clientId: string
	readonly proxySource: ZeropsNamespaceProxySource
	readonly apiBaseUrl?: string
	readonly secrets: InstallationSecrets
	/** The Zerops integration token minted for the control plane. Never logged, never printed. */
	readonly zeropsAccessToken: string
	/** IAM sends its own mail with it, and Control hands it to applications whose job declares `mailer: 'installation'`. */
	readonly email: InstallationEmail
}

/**
 * EVERY variable this command places, per service: fabrika's (`installationServiceEnvironment`) over this
 * project's own references, and control's Zerops variables after them.
 *
 * Pure, and exported, because the matrix is the thing most worth pinning: a name that is right on
 * Cloudflare and wrong on Bun is a silent no-op rather than a failure. No key any service declares in its
 * own `zerops.yaml` appears here — `PORT`, `FABRIKA_IAM_RPC_URL`, `FABRIKA_OPERATIONS_URL`,
 * `FABRIKA_CONTROL_ASSETS_DIR`, `FABRIKA_CONTROL_URL`, `FABRIKA_PROXY_MANIFEST`, `FABRIKA_PROXY_PORT`. The env
 * API refuses those (`provider-zerops/src/api.ts`), because the conflict cannot be resolved to a record id.
 */
export const installationServiceEnv = (input: InstallationEnvInput): ReadonlyMap<PlatformDeployService, ReadonlyMap<string, string>> => {
	const { secrets } = input
	const operationsData = OPERATIONS_DATA[input.tier]
	const fabrika = installationServiceEnvironment({
		environment: input.environment,
		scheme: input.scheme,
		hosts: input.hosts,
		iamUpstream: PRIVATE_IAM_UPSTREAM,
		secrets,
		email: input.email,
		data: {
			iamDatabase: postgresUrl('db'),
			controlDatabase: postgresUrl('db'),
			operationsDatabase: postgresUrl(operationsData.database),
			runLogs: storageOf('storage'),
			operationsBlobs: storageOf(operationsData.storage),
		},
	})
	const control = new Map([
		...fabrika.control,
		['FABRIKA_ZEROPS_CLIENT_ID', input.clientId],
		[FABRIKA_ZEROPS_PROXY_SOURCE_JSON, serializeNamespaceProxySource(input.proxySource)],
		// The PUBLIC IAM origin an application project's proxy reaches: there is no private network
		// between Zerops projects (ADR-0006).
		['FABRIKA_ZEROPS_PROXY_IAM_URL', platformOrigin(input.scheme, input.hosts.iam)],
		['FABRIKA_ZEROPS_PROXY_IAM_KEY', secrets.proxyKey],
		['FABRIKA_ZEROPS_ACCESS_TOKEN', input.zeropsAccessToken],
		['FABRIKA_ZEROPS_PLATFORM_PROJECT_ID', input.projectId],
	])
	if (input.apiBaseUrl !== undefined) {
		// Only when the installation is not on the default region. Control spells it `_API_BASE_URL` while
		// the CLI reads `FABRIKA_ZEROPS_API_URL`; they are different processes reading different sources.
		control.set('FABRIKA_ZEROPS_API_BASE_URL', input.apiBaseUrl)
	}
	return new Map<PlatformDeployService, ReadonlyMap<string, string>>([
		['iam', fabrika.iam],
		['operations', fabrika.operations],
		['control', control],
		['proxy', fabrika.proxy],
	])
}

/**
 * The keys whose VALUE this command generates, per service: fabrika's, and the two Zerops names on control
 * that carry the proxy key and the minted token.
 *
 * Their presence on a live service is what "this project already holds an installation" means, and it is
 * checked by KEY only — a value is never read back for comparison. `__tests__/install.test.ts` pins this
 * against the matrix above, so a new generated secret cannot be added without appearing here.
 */
export const GENERATED_SECRET_KEYS: ReadonlyMap<PlatformDeployService, readonly string[]> = new Map<PlatformDeployService, readonly string[]>([
	['iam', INSTALLATION_SECRET_VARIABLES.iam],
	['operations', INSTALLATION_SECRET_VARIABLES.operations],
	['control', [...INSTALLATION_SECRET_VARIABLES.control, 'FABRIKA_ZEROPS_PROXY_IAM_KEY', 'FABRIKA_ZEROPS_ACCESS_TOKEN']],
	['proxy', INSTALLATION_SECRET_VARIABLES.proxy],
])

/**
 * Write a set of variables, reporting the KEYS — never a value, not even in a debug line.
 *
 * Write-first and unconditional: a generated secret cannot be read back to compare, and `PUT
 * /user-data/{id}` replaces in place, so a repeat costs a call and nothing else. Exactly the `sensitive`
 * keys are written sensitive (the generated secrets and the operator's mail credentials); everything else
 * stays readable, because `platform deploy` compares and merges it later.
 */
export const writeServiceEnv = async (
	service: ResolvedService,
	desired: ReadonlyMap<string, string>,
	{ api, log, signal }: InstallCollaborators,
	sensitive: ReadonlySet<string>,
): Promise<void> => {
	for (const [key, value] of desired) {
		assertRunning(signal)
		await api.putServiceEnv({ serviceId: service.id, key, value, sensitive: sensitive.has(key), signal })
	}
	log.ok(`${service.hostname}: wrote ${[...desired.keys()].join(', ')}`)
}
