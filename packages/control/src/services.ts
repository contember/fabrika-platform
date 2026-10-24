import type { AuthContext } from '@fabrika/auth'
import { type DeployLocks, SqlDeployLocks } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import type { BuilderPairingIam } from './api/builder-pairing'
import { type NamespaceProxyChanged, republishNamespace } from './api/namespaces'
import type { DeployQueue, LogReader } from './api/runs'
import { httpOpsTransport, type OpsTransport } from './data-operations'
import type { ControlRepositories, RunRow } from './db'
import type { Env } from './env'
import { GitHubConnectionWebhookSecretProvider } from './github/connections/webhook-secret'
import type { CommitSource } from './github/source/commit-files'
import { ConnectionWebhookVerifier, type PushWebhookVerifier } from './github/triggers/push-event'
import { controlPublicOrigin } from './iam'
import { iamAdminSchema, type IamSchemaPort } from './iam-schema'
import { iamBrandSource, type InstallationBrandSource } from './installation-brand'
import type { MailRelay } from './mail-relay/queue'
import { iamMembershipKeyIssuer, type MembershipTransportPort, VaultMembershipTransport } from './membership-transport'
import {
	type OperationsCatalogSyncDeps,
	type OperationsCatalogSyncSummary,
	projectOperationsCatalogChange,
	replayOperationsCatalog,
} from './operations-catalog'
import type { OperationsReleaseProjectionDeps } from './operations-releases'
import { type OpsKeysPort, VaultOpsKeys } from './ops-key'
import { type PlatformTransportPort, VaultPlatformTransport } from './platform-transport'
import { type ProxySecrets, VaultProxySecrets } from './proxy-secret'
import { cancelDeploy, type RunDeps } from './run-lifecycle'
import { VaultSecretResolver } from './secret-resolver'
import { type TokenKeysPort, VaultTokenKeys } from './token-keys'
import { Vault } from './vault'
import { iamWorkloadKeyIssuer, VaultWorkloadCredentials, type WorkloadCredentialsPort } from './workload-credentials'

export const DEPLOY_LOCK_REQUEUE_DELAY_S = 30
export const STALE_RUN_MAX_AGE_S = 30 * 60

export function repositories(env: Env): ControlRepositories {
	return env.REPOSITORIES
}

export function locks(env: Env): DeployLocks {
	return new SqlDeployLocks(env.DB)
}

export function operationsCatalogDeps(env: Env): OperationsCatalogSyncDeps {
	const operationsOrigin = env.OPERATIONS_ARTIFACT_ORIGIN?.trim()
	return {
		catalog: repositories(env).operationsCatalog,
		locks: locks(env),
		...(env.OPERATIONS === undefined ? {} : { service: env.OPERATIONS }),
		...(env.OPERATIONS_SYNC_KEY === undefined ? {} : { syncKey: env.OPERATIONS_SYNC_KEY }),
		...(operationsOrigin === undefined || operationsOrigin === '' ? {} : { operationsOrigin }),
	}
}

export function operationsReleaseDeps(env: Env): OperationsReleaseProjectionDeps {
	const artifactOrigin = env.OPERATIONS_ARTIFACT_ORIGIN?.trim()
	return {
		repository: repositories(env).operationsReleases,
		terminalRepair: { runs: repositories(env).runs },
		...(env.OPERATIONS === undefined ? {} : { service: env.OPERATIONS }),
		...(env.OPERATIONS_SYNC_KEY === undefined ? {} : { syncKey: env.OPERATIONS_SYNC_KEY }),
		...(artifactOrigin === undefined || artifactOrigin === '' ? {} : { artifactOrigin }),
	}
}

/** Registry writes stay successful even when Operations is unavailable. */
export function scheduleOperationsCatalogChange(env: Env): void {
	env.WAIT_UNTIL(projectOperationsCatalogChange(operationsCatalogDeps(env)))
}

/** Scheduled repair path; the sync function converts transport failures into a durable failed summary. */
export function replayOperationsCatalogProjection(env: Env): Promise<OperationsCatalogSyncSummary> {
	return replayOperationsCatalog(operationsCatalogDeps(env))
}

/** A route selects one exact connection's vault secret before its request body is read (ADR-0029). */
export function connectionWebhookVerifier(env: Env, connectionId: string): PushWebhookVerifier {
	return new ConnectionWebhookVerifier(new GitHubConnectionWebhookSecretProvider(env.REPOSITORIES.githubConnections, () => vault(env), connectionId))
}

export function vault(env: Env): Promise<Vault> {
	if (env.FABRIKA_CONTROL_VAULT_KEY === undefined) {
		return Promise.reject(new Error('FABRIKA_CONTROL_VAULT_KEY is not set'))
	}
	return Vault.create(env.DB, env.FABRIKA_CONTROL_VAULT_KEY)
}

/** Assemble provider-neutral run dependencies around one statically selected provider. */
export async function buildRunDeps(env: Env, provider: ControlProvider): Promise<RunDeps> {
	return {
		repositories: repositories(env),
		provider,
		secrets: new VaultSecretResolver({
			...(env.FABRIKA_CONTROL_VAULT_KEY !== undefined ? { vault: await vault(env) } : {}),
		}),
		lock: locks(env),
		queue: env.DEPLOY_QUEUE,
		logs: env.RUN_LOGS,
		runLogs: env.RUN_LOGS,
		...(env.COMMITS === undefined ? {} : { commits: env.COMMITS }),
		...(env.MAIL_TRANSPORT === undefined ? {} : { mailTransport: env.MAIL_TRANSPORT }),
		operations: operationsReleaseDeps(env),
		// The installation's own IAM issuer, which every application it deploys verifies against (ADR-0035).
		...(env.FABRIKA_IAM_ISSUER === undefined ? {} : { iamIssuer: env.FABRIKA_IAM_ISSUER }),
		...iamSchemaDeps(env),
		...controlOriginDeps(env),
		...proxySecretDeps(env),
		...installationBrandDeps(env),
		...workloadCredentialDeps(env),
		...membershipTransportDeps(env),
		...platformTransportDeps(env),
		...tokenKeyDeps(env),
		...opsKeyDeps(env),
	}
}

/** A succeeded run's schema goes to IAM at the installation's issuer; an installation that names none writes no schema. */
export function iamSchemaDeps(env: Env): { iamSchema?: IamSchemaPort } {
	const origin = env.FABRIKA_IAM_ISSUER?.trim() ?? ''
	if (origin === '') return {}
	const provisioningKey = env.FABRIKA_IAM_PROVISIONING_KEY?.trim() ?? ''
	return { iamSchema: iamAdminSchema({ origin, ...(provisioningKey === '' ? {} : { provisioningKey }) }) }
}

/** The token keys live in the vault, so an installation without one keeps none, and a contract with a purpose does not deploy. */
export function tokenKeyDeps(env: Env): { tokenKeys?: TokenKeysPort } {
	return env.FABRIKA_CONTROL_VAULT_KEY === undefined ? {} : { tokenKeys: new VaultTokenKeys(repositories(env).tokenKeys, () => vault(env)) }
}

/** The ops keys live in the vault, so an installation without one keeps none, and a deploy at a gated release fails. */
export function opsKeyDeps(env: Env): { opsKeys?: OpsKeysPort } {
	return env.FABRIKA_CONTROL_VAULT_KEY === undefined ? {} : { opsKeys: new VaultOpsKeys(repositories(env).opsKeys, () => vault(env)) }
}

function opsTransportDeps(env: Env): { opsTransport?: OpsTransport } {
	const { opsKeys } = opsKeyDeps(env)
	if (opsKeys === undefined) return {}
	return { opsTransport: httpOpsTransport({ registry: repositories(env).registry, opsKeysFor: (appId, name) => opsKeys.opsKeysFor(appId, name) }) }
}

/**
 * The membership transport keys are issued by IAM with the provisioning key and sealed in the vault, like the workload
 * keys; an installation without all three issues none, and a contract that needs one does not deploy behind a
 * namespace proxy there.
 */
export function membershipTransportDeps(env: Env): { membershipTransport?: MembershipTransportPort } {
	const origin = env.FABRIKA_IAM_ISSUER?.trim() ?? ''
	const provisioningKey = env.FABRIKA_IAM_PROVISIONING_KEY?.trim() ?? ''
	if (env.FABRIKA_CONTROL_VAULT_KEY === undefined || origin === '' || provisioningKey === '') {
		return {}
	}
	const issuer = iamMembershipKeyIssuer({ origin, provisioningKey })
	return { membershipTransport: new VaultMembershipTransport(repositories(env).membershipKeys, () => vault(env), issuer) }
}

function controlOriginDeps(env: Env): { controlOrigin?: string } {
	const origin = controlPublicOrigin(env)
	return origin === undefined ? {} : { controlOrigin: origin }
}

/** Control issues the platform transport keys itself and seals them in the vault; without a vault it issues none. */
export function platformTransportDeps(env: Env): { platformTransport?: PlatformTransportPort } {
	if (env.FABRIKA_CONTROL_VAULT_KEY === undefined) {
		return {}
	}
	return { platformTransport: new VaultPlatformTransport(repositories(env).platformTransportKeys, () => vault(env)) }
}

/**
 * Workload keys are issued by IAM with the provisioning key and sealed in the vault; an installation without all three
 * issues none, and a contract with a job or a webhook does not deploy there.
 */
export function workloadCredentialDeps(env: Env): { workloadCredentials?: WorkloadCredentialsPort } {
	const origin = env.FABRIKA_IAM_ISSUER?.trim() ?? ''
	const provisioningKey = env.FABRIKA_IAM_PROVISIONING_KEY?.trim() ?? ''
	if (env.FABRIKA_CONTROL_VAULT_KEY === undefined || origin === '' || provisioningKey === '') {
		return {}
	}
	const issuer = iamWorkloadKeyIssuer({ origin, provisioningKey })
	return { workloadCredentials: new VaultWorkloadCredentials(repositories(env).workloadCredentials, () => vault(env), issuer) }
}

/**
 * The installation's client logo is read from IAM with the provisioning key (ADR-0066); an installation without the
 * issuer or the key publishes its proxies with the fabrika mark.
 */
export function installationBrandDeps(env: Env): { brand?: InstallationBrandSource } {
	const origin = env.FABRIKA_IAM_ISSUER?.trim() ?? ''
	const provisioningKey = env.FABRIKA_IAM_PROVISIONING_KEY?.trim() ?? ''
	return origin === '' || provisioningKey === '' ? {} : { brand: iamBrandSource({ origin, provisioningKey }) }
}

/** The proxy secrets live in the vault, so an installation without one hands the providers none. */
export function proxySecretDeps(env: Env): { proxySecrets?: ProxySecrets } {
	return env.FABRIKA_CONTROL_VAULT_KEY === undefined ? {} : { proxySecrets: new VaultProxySecrets(repositories(env).registry, () => vault(env)) }
}

export async function cancelRun(env: Env, provider: ControlProvider, run: RunRow): Promise<void> {
	await cancelDeploy(
		{ repositories: repositories(env), provider, lock: locks(env), runLogs: env.RUN_LOGS, ...platformTransportDeps(env), ...iamSchemaDeps(env) },
		run,
	)
}

export interface ControlRpcDeps {
	builderPairingIam?: BuilderPairingIam
	repositories: ControlRepositories
	auth: AuthContext
	queue: DeployQueue
	logs: LogReader
	provider: ControlProvider
	/** The run leases an approval writes under; absent, approvals answer 503. */
	lock?: DeployLocks
	cancelRun: (run: RunRow) => Promise<void>
	vault?: () => Promise<Vault>
	catalogChanged?: () => void
	namespaceProxyChanged?: NamespaceProxyChanged
	/** The installation's client logo, which IAM keeps (ADR-0066). */
	brand?: InstallationBrandSource
	/** GitHub as a deploy reads it; `register` probes an anonymous source with it. */
	commits?: CommitSource
	/**
	 * The relay's dispatcher queue a released or requeued message joins, and its transport; absent on the Worker, which
	 * has no dispatcher.
	 */
	mailRelay?: Pick<MailRelay, 'queue' | 'sender'>
	/** The ops channel to an environment's object; absent without a vault, and the `data.*` calls to an object answer 503. */
	opsTransport?: OpsTransport
}

/** Assemble RPC use-case dependencies around the installation's provider. Vault creation stays lazy. */
export function buildControlRpcDeps(env: Env, provider: ControlProvider, auth: AuthContext): ControlRpcDeps {
	return {
		repositories: repositories(env),
		auth,
		queue: env.DEPLOY_QUEUE,
		logs: env.RUN_LOGS,
		provider,
		lock: locks(env),
		cancelRun: (run) => cancelRun(env, provider, run),
		vault: () => vault(env),
		catalogChanged: () => scheduleOperationsCatalogChange(env),
		...(env.COMMITS === undefined ? {} : { commits: env.COMMITS }),
		...(env.MAIL_RELAY === undefined ? {} : { mailRelay: env.MAIL_RELAY }),
		...installationBrandDeps(env),
		...opsTransportDeps(env),
		...(provider.namespaces?.republish === undefined
			? {}
			: {
				namespaceProxyChanged: (namespaceId, options) =>
					republishNamespace(
						{
							repositories: repositories(env),
							provider,
							lock: locks(env),
							queue: env.DEPLOY_QUEUE,
							...proxySecretDeps(env),
							...installationBrandDeps(env),
						},
						namespaceId,
						{ wait: 'started', ...(options?.brand === undefined ? {} : { brand: options.brand }) },
					),
			}),
	}
}
