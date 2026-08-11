import type { RunLogLine } from '@fabrika/control-contract'
import {
	OPERATIONS_MANAGED_ENVIRONMENT_KEYS,
	operationsManagedEnvironment,
	operationsManagedEnvironmentCollisions,
} from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE } from '@fabrika/operations-contract/releases'
import type { BlobStore } from '@fabrika/platform'
import type {
	ControlProvider,
	JsonValue,
	ProviderApp,
	ProviderDeploymentNamespace,
	ProviderEnvelope,
	ProviderEnvironment,
	ProviderTerminalOutcome,
} from '@fabrika/provider-contract'
import { type AppEnvRow, type AppRow, type ControlRegistryRepository, type ControlRepositories, type DeploymentNamespaceRow, type RunRow } from './db'
import { type OperationsReleaseProjectionDeps, projectOperationsRun } from './operations-releases'
import { projectedReturnOrigins } from './return-origins'
import type { SecretResolver } from './secret-resolver'

export type RunOutcome = ProviderTerminalOutcome

/** The per-app-env deploy lock seam. */
export interface DeployLockGate {
	acquire(key: string, holder: string): Promise<boolean>
	release(key: string, holder: string): Promise<void>
}

/** Everything the provider-neutral lifecycle needs. */
export interface RunDeps {
	repositories: ControlRepositories
	secrets: SecretResolver
	provider: ControlProvider
	lock: DeployLockGate
	logs: Pick<BlobStore, 'put'>
	operations?: OperationsReleaseProjectionDeps
}

export interface DeployJobMessage {
	runId: string
	dryRun?: boolean
}

const logsKey = (runId: string): string => `runs/${runId}/logs.ndjson`

class RunLogWriter {
	readonly #lines: RunLogLine[] = []
	#writeQueue: Promise<void> = Promise.resolve()

	constructor(
		private readonly logs: Pick<BlobStore, 'put'>,
		private readonly key: string,
		private readonly runId: string,
	) {}

	log(text: string): void {
		console.info(`deploy run ${this.runId}: ${text}`)
		this.#lines.push({ ts: Date.now(), stream: 'meta', text })
		const contents = `${this.#lines.map((line) => JSON.stringify(line)).join('\n')}\n`
		this.#writeQueue = this.#writeQueue
			.then(() => this.logs.put(this.key, contents))
			.catch(() => console.error(`deploy run ${this.runId}: failed to persist log output`))
	}

	async flush(): Promise<void> {
		await this.#writeQueue
	}
}

const isJsonValue = (value: unknown): value is JsonValue => {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return true
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue)
	}
	if (typeof value !== 'object') {
		return false
	}
	return Object.values(value).every(isJsonValue)
}

/** Parse a persisted provider envelope without trusting database text. */
export const parseProviderEnvelope = (raw: string, label: string): ProviderEnvelope => {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		throw new Error(`${label} is not valid JSON`)
	}
	if (
		typeof value !== 'object'
		|| value === null
		|| !('provider' in value && typeof value.provider === 'string' && value.provider !== '')
		|| !('version' in value && typeof value.version === 'number' && Number.isInteger(value.version))
		|| !('payload' in value && isJsonValue(value.payload))
	) {
		throw new Error(`${label} is not a provider envelope`)
	}
	return { provider: value.provider, version: value.version, payload: value.payload }
}

const providerApp = (app: AppRow, run: RunRow): ProviderApp => ({
	id: app.id,
	source: {
		repoUrl: app.repo_url,
		ref: run.ref,
		...(app.worker_dir === null ? {} : { workerDir: app.worker_dir }),
		...(app.build_cmd === null ? {} : { buildCommand: app.build_cmd }),
		...(app.config_path === null ? {} : { configPath: app.config_path }),
		...(app.github_installation_id === null ? {} : { githubInstallationId: app.github_installation_id }),
	},
})

/** Convert one validated namespace row into the provider contract. */
const providerNamespace = (row: DeploymentNamespaceRow): ProviderDeploymentNamespace => ({
	id: row.id,
	env: row.env,
	...(row.exclusive_app_id === null ? {} : { exclusiveAppId: row.exclusive_app_id }),
	target: parseProviderEnvelope(row.provider_target_json, `target for namespace ${row.id}`),
})

const storedProviderEnvironment = (
	row: AppEnvRow,
	namespace?: ProviderDeploymentNamespace,
): ProviderEnvironment => ({
	appId: row.app_id,
	env: row.env,
	...(row.domain === null ? {} : { domain: row.domain }),
	...(row.public_origin === null ? {} : { publicOrigin: row.public_origin }),
	...(namespace === undefined ? {} : { namespace }),
	target: parseProviderEnvelope(row.provider_target_json, `target for ${row.app_id}/${row.env}`),
	artifact: parseProviderEnvelope(row.provider_artifact_json, `artifact for ${row.app_id}/${row.env}`),
})

/**
 * Hydrate one persisted environment at the generic control-provider boundary.
 *
 * Deploys require a ready namespace. Cancellation, reconciliation, and managed-secret cleanup still
 * need the original coordinates while a namespace is degraded, so those callers omit that guard.
 */
export const providerEnvironment = async (
	db: Pick<ControlRegistryRepository, 'getDeploymentNamespace'>,
	row: AppEnvRow,
	options: { requireReadyNamespace?: boolean } = {},
): Promise<ProviderEnvironment> => {
	let namespace: ProviderDeploymentNamespace | undefined
	if (row.namespace_id !== null) {
		const stored = await db.getDeploymentNamespace(row.namespace_id)
		if (stored === null) {
			throw new Error(`deployment namespace "${row.namespace_id}" is missing`)
		}
		if (stored.provider !== row.provider || stored.env !== row.env) {
			throw new Error(`deployment namespace "${stored.id}" has incompatible provider coordinates`)
		}
		if (stored.exclusive_app_id !== null && stored.exclusive_app_id !== row.app_id) {
			throw new Error(`deployment namespace "${stored.id}" is exclusive to another app`)
		}
		if (options.requireReadyNamespace === true && stored.state !== 'ready') {
			throw new Error(`deployment namespace "${stored.id}" is not ready`)
		}
		namespace = providerNamespace(stored)
	}
	const environment = storedProviderEnvironment(row, namespace)
	if (
		environment.target.provider !== row.provider
		|| environment.artifact.provider !== row.provider
		|| (environment.namespace !== undefined && environment.namespace.target.provider !== row.provider)
	) {
		throw new Error('persisted deploy registration belongs to another provider')
	}
	return environment
}

const assertNamespaceResourceClaims = async (
	db: ControlRegistryRepository,
	provider: ControlProvider,
	registration: { app: ProviderApp; environment: ProviderEnvironment },
): Promise<void> => {
	const namespace = registration.environment.namespace
	if (namespace === undefined) {
		return
	}
	const capabilities = provider.namespaces
	if (capabilities === undefined) {
		throw new Error(`provider "${provider.id}" cannot verify deployment namespace claims`)
	}
	const claims = await db.listNamespaceResourceClaims(namespace.id)
	const byKey = new Map(claims.map((claim) => [claim.resource_key, claim]))
	for (const key of capabilities.namespaceResourceClaims(namespace)) {
		const claim = byKey.get(key)
		if (claim === undefined || claim.owner_app_id !== null || claim.owner_env !== null) {
			throw new Error(`deployment namespace resource claim "${key}" is missing or has another owner`)
		}
	}
	for (const key of capabilities.registrationResourceClaims(registration)) {
		const claim = byKey.get(key)
		if (
			claim === undefined
			|| claim.owner_app_id !== registration.app.id
			|| claim.owner_env !== registration.environment.env
		) {
			throw new Error(`application resource claim "${key}" is missing or has another owner`)
		}
	}
}

const resolveVars = async (db: ControlRegistryRepository, appId: string, env: string): Promise<Record<string, string>> => {
	const vars: Record<string, string> = {}
	for (const row of await db.getAppVarsForEnv(appId, env)) {
		vars[row.name] = row.value
	}
	return vars
}

const resolveSecrets = async (
	deps: RunDeps,
	appId: string,
	env: string,
): Promise<Record<string, string>> => {
	if (deps.provider.secrets !== undefined) {
		return {}
	}
	const secrets: Record<string, string> = {}
	for (const row of await deps.repositories.registry.getAppSecretsForEnv(appId, env)) {
		secrets[row.name] = await deps.secrets.resolveSecret(row.value_ref)
	}
	return secrets
}

/**
 * Execute one queued deploy through the statically selected provider.
 *
 * Core owns locking and terminal database transitions. The provider owns source delivery, deploy
 * mechanics, external operation ids, reconciliation, and provider-managed secret semantics.
 */
export async function executeDeploy(
	deps: RunDeps,
	message: DeployJobMessage,
): Promise<{ runId: string; status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'deferred' }> {
	const run = await deps.repositories.runs.getRun(message.runId)
	if (run === null) {
		return { runId: message.runId, status: 'skipped' }
	}
	if (run.status !== 'pending') {
		return { runId: run.id, status: 'skipped' }
	}

	const lockKey = `${run.app_id}:${run.env}`
	if (!(await deps.lock.acquire(lockKey, run.id))) {
		return { runId: run.id, status: 'deferred' }
	}

	try {
		if (!(await deps.repositories.runs.markRunStarted(run.id, logsKey(run.id)))) {
			return { runId: run.id, status: 'skipped' }
		}
		const startedRun = await deps.repositories.runs.getRun(run.id)
		if (startedRun === null) return { runId: run.id, status: 'skipped' }
		if (startedRun.log_key === null) throw new Error('started run has no log key')
		const releaseContext = deps.operations === undefined
			? null
			: await projectOperationsRun(deps.operations, startedRun, {
				dryRun: message.dryRun === true,
				phase: 'started',
				artifactState: 'pending',
			})
		const app = await deps.repositories.registry.getApp(run.app_id)
		const appEnv = await deps.repositories.registry.getAppEnv(run.app_id, run.env)
		if (app === null || appEnv === null) {
			await deps.repositories.runs.markRunFinished(run.id, 'failed', null)
			await projectTerminalRun(deps, run.id, message.dryRun === true, 'failed')
			return { runId: run.id, status: 'failed' }
		}
		if (appEnv.provider !== deps.provider.id) {
			throw new Error(
				`configured provider "${deps.provider.id}" cannot deploy ${app.id}/${appEnv.env} owned by "${appEnv.provider}"`,
			)
		}
		const appInput = providerApp(app, run)
		const environmentInput = await providerEnvironment(deps.repositories.registry, appEnv, { requireReadyNamespace: true })
		const registration = deps.provider.normalizeRegistration({
			app: appInput,
			environment: environmentInput,
		})
		if (
			registration.app.id !== app.id
			|| registration.environment.appId !== app.id
			|| registration.environment.env !== appEnv.env
			|| registration.environment.publicOrigin !== environmentInput.publicOrigin
			|| registration.environment.target.provider !== deps.provider.id
			|| registration.environment.artifact.provider !== deps.provider.id
			|| registration.environment.namespace?.id !== environmentInput.namespace?.id
			|| registration.environment.namespace?.env !== environmentInput.namespace?.env
			|| registration.environment.namespace?.exclusiveAppId !== environmentInput.namespace?.exclusiveAppId
			|| registration.environment.namespace?.target.provider !== environmentInput.namespace?.target.provider
		) {
			throw new Error('provider returned a deploy registration for different coordinates')
		}
		await assertNamespaceResourceClaims(deps.repositories.registry, deps.provider, registration)

		const vars = await resolveVars(deps.repositories.registry, app.id, appEnv.env)
		const operationsCollisions = operationsManagedEnvironmentCollisions(Object.keys(vars))
		if (operationsCollisions.length > 0) {
			throw new Error(`application variable "${operationsCollisions[0]}" is managed by Fabrika`)
		}
		const managedEnvironment: Record<string, string | null> = { [FABRIKA_RELEASE]: null }
		for (const key of OPERATIONS_MANAGED_ENVIRONMENT_KEYS) managedEnvironment[key] = null
		const ingest = await deps.repositories.operationsCatalog.getActiveIngestConfig(app.id, appEnv.env)
		if (ingest?.dsn !== null && ingest?.dsn !== undefined) {
			Object.assign(
				managedEnvironment,
				operationsManagedEnvironment({
					dsn: ingest.dsn,
					appId: app.id,
					environment: appEnv.env,
					serviceKey: ingest.service_key,
				}),
			)
		}
		if (releaseContext !== null) {
			for (const key of Object.keys(releaseContext.managedEnvironment)) {
				if (vars[key] !== undefined) throw new Error(`application variable "${key}" is managed by Fabrika`)
			}
			Object.assign(managedEnvironment, releaseContext.managedEnvironment)
		}
		const returnOrigins = await projectedReturnOrigins(deps.repositories.registry, app.id)
		const runLogs = new RunLogWriter(deps.logs, startedRun.log_key, run.id)
		let outcome: ProviderTerminalOutcome
		try {
			outcome = await deps.provider.deploy({
				runId: run.id,
				app: registration.app,
				environment: registration.environment,
				secrets: await resolveSecrets(deps, app.id, appEnv.env),
				vars,
				managedEnvironment,
				...(returnOrigins === undefined ? {} : { returnOrigins }),
				dryRun: message.dryRun === true,
				...(releaseContext?.artifactUpload === undefined ? {} : { artifactUpload: releaseContext.artifactUpload }),
				signal: new AbortController().signal,
				events: {
					log: (line) => runLogs.log(line),
					externalId: async (externalId) => {
						await deps.repositories.runs.setRunExternalId(run.id, externalId)
						const acceptedRun = await deps.repositories.runs.getRun(run.id)
						if (deps.operations !== undefined && acceptedRun !== null) {
							await projectOperationsRun(deps.operations, acceptedRun, {
								dryRun: message.dryRun === true,
								phase: 'provider_accepted',
								artifactState: 'pending',
							})
						}
					},
				},
			})
		} finally {
			await runLogs.flush()
		}
		await deps.repositories.runs.markRunFinished(run.id, outcome.state, outcome.exitCode ?? null)
		await projectTerminalRun(deps, run.id, message.dryRun === true, outcome.state, outcome.artifactState)
		return { runId: run.id, status: outcome.state }
	} catch (error) {
		console.error(`deploy run ${run.id} failed:`, error instanceof Error ? error.message : 'unknown error')
		await deps.repositories.runs.markRunFinished(run.id, 'failed', null)
		await projectTerminalRun(deps, run.id, message.dryRun === true, 'failed')
		return { runId: run.id, status: 'failed' }
	} finally {
		await deps.lock.release(lockKey, run.id)
	}
}

export async function projectTerminalRun(
	deps: Pick<RunDeps, 'repositories' | 'operations'>,
	runId: string,
	dryRun: boolean,
	outcome: 'succeeded' | 'failed',
	artifactState?: 'complete' | 'incomplete' | 'not_applicable',
): Promise<void> {
	if (deps.operations === undefined) return
	const terminalRun = await deps.repositories.runs.getRun(runId)
	if (terminalRun === null) return
	await projectOperationsRun(deps.operations, terminalRun, {
		dryRun,
		phase: 'terminal',
		artifactState: dryRun ? 'not_applicable' : artifactState ?? 'incomplete',
		outcome,
	})
}

/** Cancel provider-owned work, mark the run failed, and release its deploy lock. */
export async function cancelDeploy(
	deps: Pick<RunDeps, 'repositories' | 'provider'> & { lock: Pick<DeployLockGate, 'release'> },
	run: RunRow,
): Promise<void> {
	const appEnv = await deps.repositories.registry.getAppEnv(run.app_id, run.env)
	if (
		appEnv !== null
		&& appEnv.provider === deps.provider.id
		&& run.external_run_id !== null
		&& deps.provider.cancel !== undefined
	) {
		await deps.provider.cancel({
			runId: run.id,
			externalId: run.external_run_id,
			environment: await providerEnvironment(deps.repositories.registry, appEnv),
		})
	}
	await deps.repositories.runs.markRunFinished(run.id, 'failed', null)
	await deps.lock.release(`${run.app_id}:${run.env}`, run.id)
}

/** Map a pushed git ref to the app environment it triggers. */
export async function refToEnv(db: ControlRegistryRepository, appId: string, ref: string): Promise<AppEnvRow | null> {
	return db.getAppEnvByTriggerRef(appId, ref)
}
