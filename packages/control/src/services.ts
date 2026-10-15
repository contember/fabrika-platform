import type { AuthContext } from '@fabrika/auth'
import { type DeployLocks, SqlDeployLocks } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import type { BuilderPairingIam } from './api/builder-pairing'
import { type NamespaceProxyChanged, republishNamespace } from './api/namespaces'
import type { DeployQueue, LogReader } from './api/runs'
import type { ControlRepositories, RunRow } from './db'
import type { Env } from './env'
import { GitHubConnectionWebhookSecretProvider } from './github/connections/webhook-secret'
import type { CommitSource } from './github/source/commit-files'
import { ConnectionWebhookVerifier, type PushWebhookVerifier } from './github/triggers/push-event'
import { iamMembershipKeyIssuer, type MembershipTransportPort, VaultMembershipTransport } from './membership-transport'
import {
	type OperationsCatalogSyncDeps,
	type OperationsCatalogSyncSummary,
	projectOperationsCatalogChange,
	replayOperationsCatalog,
} from './operations-catalog'
import type { OperationsReleaseProjectionDeps } from './operations-releases'
import { type ProxySecrets, VaultProxySecrets } from './proxy-secret'
import { cancelDeploy, type RunDeps } from './run-lifecycle'
import { VaultSecretResolver } from './secret-resolver'
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
		operations: operationsReleaseDeps(env),
		// The installation's own IAM issuer, which every application it deploys verifies against (ADR-0035).
		...(env.FABRIKA_IAM_ISSUER === undefined ? {} : { iamIssuer: env.FABRIKA_IAM_ISSUER }),
		...proxySecretDeps(env),
		...workloadCredentialDeps(env),
		...membershipTransportDeps(env),
	}
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

/** The proxy secrets live in the vault, so an installation without one hands the providers none. */
export function proxySecretDeps(env: Env): { proxySecrets?: ProxySecrets } {
	return env.FABRIKA_CONTROL_VAULT_KEY === undefined ? {} : { proxySecrets: new VaultProxySecrets(repositories(env).registry, () => vault(env)) }
}

export async function cancelRun(env: Env, provider: ControlProvider, run: RunRow): Promise<void> {
	await cancelDeploy({ repositories: repositories(env), provider, lock: locks(env) }, run)
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
	/** GitHub as a deploy reads it; `register` probes an anonymous source with it. */
	commits?: CommitSource
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
		...(provider.namespaces?.republish === undefined
			? {}
			: {
				namespaceProxyChanged: (namespaceId: string) =>
					republishNamespace(
						{ repositories: repositories(env), provider, lock: locks(env), queue: env.DEPLOY_QUEUE, ...proxySecretDeps(env) },
						namespaceId,
						{ wait: 'started' },
					),
			}),
	}
}
