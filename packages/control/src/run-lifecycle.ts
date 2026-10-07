import { FABRIKA_IAM_ISSUER } from '@fabrika/auth-core'
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
	ProviderApp,
	ProviderDeployInput,
	ProviderDeploymentNamespace,
	ProviderDeployOutcome,
	ProviderEnvelope,
	ProviderEnvironment,
	ProviderSourceBinding,
	ProviderTerminalOutcome,
} from '@fabrika/provider-contract'
import { lifecycleEnvelopeSchema } from './api/provider-envelope'
import {
	type AppEnvRow,
	type AppRow,
	type ControlRegistryRepository,
	type ControlRepositories,
	type DeploymentNamespaceRow,
	type OperationsCatalogRepository,
	parseProviderJson,
	type RunRow,
} from './db'
import { type OperationsReleaseProjectionDeps, projectOperationsRun } from './operations-releases'
import { projectedReturnOrigins } from './return-origins'
import { type DeployLockGate, type OwnershipTiming, RunOwnership } from './run-ownership'
import { appSecretPurpose, type SecretResolver } from './secret-resolver'

export type { DeployLockGate } from './run-ownership'
export type RunOutcome = ProviderTerminalOutcome

/** Everything the provider-neutral lifecycle needs. */
export interface RunDeps {
	repositories: ControlRepositories
	secrets: SecretResolver
	provider: ControlProvider
	lock: DeployLockGate
	ownershipTiming?: OwnershipTiming
	logs: Pick<BlobStore, 'put'>
	operations?: OperationsReleaseProjectionDeps
	/**
	 * This installation's IAM issuer, delivered to every application it deploys (ADR-0035). Optional
	 * because a composition may not know its own public IAM origin; then the name is REMOVED from the
	 * service rather than left stale, and an app that requires it fails its own boot, loudly.
	 */
	iamIssuer?: string
}

export interface DeployJobMessage {
	runId: string
	dryRun?: boolean
	/** Absent on a deploy job — declared so the union discriminates and pre-namespace payloads still decode. */
	kind?: undefined
}

export type NamespaceJobMutation = 'provision' | 'reconcile'

/** Namespace provisioning as a queued job: the request records the row and returns (backlog 74). */
export interface NamespaceJobMessage {
	kind: 'namespace'
	namespaceId: string
	mutation: NamespaceJobMutation
}

/** Everything the ONE control queue carries. A payload without `kind` is a deploy job. */
export type ControlJobMessage = DeployJobMessage | NamespaceJobMessage

export const logsKey = (runId: string): string => `runs/${runId}/logs.ndjson`

const immutableGitObjectId = (value: string, label: string): string => {
	const normalized = value.toLowerCase()
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalized)) {
		throw new Error(`${label} is not an immutable Git object id`)
	}
	return normalized
}

const providerAppAtCommit = (app: ProviderApp, commitSha: string): ProviderApp => ({
	...app,
	source: { ...app.source, ref: commitSha },
})

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

/** Parse a persisted provider envelope without trusting database text. */
export const parseProviderEnvelope = (raw: string, label: string): ProviderEnvelope => {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		throw new Error(`${label} is not valid JSON`)
	}
	const parsed = lifecycleEnvelopeSchema.safeParse(value)
	if (!parsed.success) {
		throw new Error(`${label} is not a provider envelope`)
	}
	return parsed.data
}

const providerApp = (app: AppRow, run: RunRow): ProviderApp => ({
	id: app.id,
	source: {
		repoUrl: app.repo_url,
		ref: run.ref,
		...(app.worker_dir === null ? {} : { workerDir: app.worker_dir }),
		...(app.build_cmd === null ? {} : { buildCommand: app.build_cmd }),
		...(app.config_path === null ? {} : { configPath: app.config_path }),
	},
})

/** The app's private-source selector in the provider's declared source mode (ADR-0029); undefined for a public source. */
const loadSourceBinding = async (deps: Pick<RunDeps, 'repositories' | 'provider'>, app: AppRow): Promise<ProviderSourceBinding | undefined> => {
	const mode = deps.provider.source?.binding
	if (mode === undefined) {
		if (app.github_connection_id !== null || app.github_installation_id !== null) {
			throw new Error(`provider "${deps.provider.id}" cannot deploy a private source`)
		}
		return undefined
	}
	return (await deps.repositories.registry.getSourceBinding(app.id, mode)) ?? undefined
}

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

/**
 * Name the catalog state a deploy observed when the environment has no active ingest configuration
 * (backlog 84). Informational only, so a catalog that cannot be read never fails the deploy.
 *
 * A composition with no Operations transport returns `disabled` before it advances a revision, so a
 * registered application whose desired revision is still 0 is the one signal here that Operations is
 * not wired at all — the run deps carry no such flag (`buildRunDeps` always populates them).
 */
async function operationsCatalogGap(catalog: OperationsCatalogRepository): Promise<string> {
	try {
		const state = await catalog.getState()
		if (state.lastError !== null) {
			return `catalog revision ${state.attemptedRevision ?? state.desiredRevision} failed: ${state.lastError}`
		}
		if (state.desiredRevision === 0 && state.lastSuccessAt === null) return 'operations catalog is disabled'
		if (state.lastAttemptAt === null && state.lastSuccessAt === null) return 'no catalog sync yet'
		if (state.desiredRevision > state.appliedRevision) return `catalog revision ${state.desiredRevision} pending`
		return `catalog revision ${state.appliedRevision} applied with no configuration for this environment`
	} catch {
		return 'catalog state unreadable'
	}
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
		// The row's OWN layer, not the deploying env: an all-env secret was sealed under scope `app`.
		secrets[row.name] = await deps.secrets.resolveSecret(row.value_ref, appSecretPurpose(appId, row.env, row.name))
	}
	return secrets
}

/** Refuse a platform-owned name before any provider effect, whichever surface let it in. */
const assertUnmanagedNames = (kind: 'variable' | 'secret', names: readonly string[]): void => {
	const collisions = operationsManagedEnvironmentCollisions(names)
	if (collisions.length > 0) {
		throw new Error(`application ${kind} "${collisions[0]}" is managed by Fabrika`)
	}
	// `FABRIKA_RELEASE` is only caught by the release-context loop below, and only when Operations is
	// configured — an installation without it had no deploy-time guard at all.
	for (const reserved of [FABRIKA_IAM_ISSUER, FABRIKA_RELEASE]) {
		if (names.includes(reserved)) {
			throw new Error(`application ${kind} "${reserved}" is managed by Fabrika`)
		}
	}
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
	let run = await deps.repositories.runs.getRun(message.runId)
	if (run === null) {
		return { runId: message.runId, status: 'skipped' }
	}
	if (run.status !== 'pending') {
		return { runId: run.id, status: 'skipped' }
	}

	const owner = await RunOwnership.acquire(deps.repositories.runs, deps.lock, run, deps.ownershipTiming)
	if (owner === null) {
		return { runId: run.id, status: 'deferred' }
	}
	run = owner.row
	const runId = run.id

	try {
		if (run.status !== 'pending') return { runId, status: 'skipped' }
		if (run.cancel_requested_at !== null) {
			const settled = await settleRunCancellation(deps, owner).catch(() => null)
			return { runId, status: settled === null ? 'running' : 'skipped' }
		}
		if (!(await deps.repositories.runs.markRunStarted(run.id, logsKey(run.id), owner.guard()))) {
			owner.invalidate()
			const latest = await deps.repositories.runs.getRun(runId)
			return { runId, status: latest?.status === 'pending' ? 'deferred' : 'skipped' }
		}
		let startedRun = await deps.repositories.runs.getRun(run.id)
		if (startedRun === null) return { runId: run.id, status: 'skipped' }
		if (startedRun.log_key === null) throw new Error('started run has no log key')
		const startedLogKey = startedRun.log_key
		const app = await deps.repositories.registry.getApp(run.app_id)
		const appEnv = await deps.repositories.registry.getAppEnv(run.app_id, run.env)
		if (app === null || appEnv === null) {
			if (await deps.repositories.runs.markRunFinished(run.id, 'failed', null, owner.guard())) {
				await projectTerminalRun(deps, run.id, message.dryRun === true, 'failed')
				return { runId: run.id, status: 'failed' }
			}
			return { runId: run.id, status: 'skipped' }
		}
		if (appEnv.provider !== deps.provider.id) {
			throw new Error(
				`configured provider "${deps.provider.id}" cannot deploy ${app.id}/${appEnv.env} owned by "${appEnv.provider}"`,
			)
		}
		const sourceBinding = await loadSourceBinding(deps, app)
		const appInput = providerApp(app, run)
		const environmentInput = await providerEnvironment(deps.repositories.registry, appEnv, { requireReadyNamespace: true })
		let registration = deps.provider.normalizeRegistration?.({ app: appInput, environment: environmentInput })
			?? { app: appInput, environment: environmentInput }
		await assertNamespaceResourceClaims(deps.repositories.registry, deps.provider, registration)
		const abortController = owner.work
		const resolveSource = deps.provider.resolveSource
		if (message.dryRun !== true && resolveSource !== undefined) {
			await owner.refreshCancellation()
			owner.work.signal.throwIfAborted()
			const expectedCommitSha = startedRun.commit_sha === null
				? undefined
				: immutableGitObjectId(startedRun.commit_sha, 'recorded commit')
			const resolution = await resolveSource({
				runId: run.id,
				app: registration.app,
				environment: registration.environment,
				...(expectedCommitSha === undefined ? {} : { expectedCommitSha }),
				...(sourceBinding === undefined ? {} : { sourceBinding }),
				signal: abortController.signal,
			})
			const commitSha = immutableGitObjectId(resolution.commitSha, 'resolved commit')
			await owner.refreshCancellation()
			owner.work.signal.throwIfAborted()
			if (expectedCommitSha !== undefined && commitSha !== expectedCommitSha) {
				throw new Error('resolved commit does not match the recorded commit')
			}
			await owner.mutate((guard) => deps.repositories.runs.setRunCommit(runId, commitSha, guard))
			const resolvedRun = await deps.repositories.runs.getRun(run.id)
			if (resolvedRun === null) throw new Error('resolved run disappeared')
			startedRun = resolvedRun
			registration = { ...registration, app: providerAppAtCommit(registration.app, commitSha) }
		}
		const releaseContext = deps.operations === undefined
			? null
			: await projectOperationsRun(deps.operations, startedRun, {
				dryRun: message.dryRun === true,
				phase: 'started',
				artifactState: 'pending',
			})

		const vars = await resolveVars(deps.repositories.registry, app.id, appEnv.env)
		assertUnmanagedNames('variable', Object.keys(vars))
		// Resolved here rather than at the provider call, so a reserved secret name fails before any effect.
		const secrets = await resolveSecrets(deps, app.id, appEnv.env)
		assertUnmanagedNames('secret', Object.keys(secrets))
		const managedEnvironment: Record<string, string | null> = { [FABRIKA_RELEASE]: null, [FABRIKA_IAM_ISSUER]: null }
		for (const key of OPERATIONS_MANAGED_ENVIRONMENT_KEYS) managedEnvironment[key] = null
		// `null` means REMOVE, so an installation that cannot name its own issuer strips a stale one
		// instead of deploying an app that verifies against the previous installation's tokens.
		if (deps.iamIssuer !== undefined && deps.iamIssuer.trim() !== '') {
			managedEnvironment[FABRIKA_IAM_ISSUER] = deps.iamIssuer.trim()
		}
		const ingest = await deps.repositories.operationsCatalog.getActiveIngestConfig(app.id, appEnv.env)
		let ingestGap: string | null = null
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
		} else {
			ingestGap = await operationsCatalogGap(deps.repositories.operationsCatalog)
		}
		if (releaseContext !== null) {
			for (const key of Object.keys(releaseContext.managedEnvironment)) {
				if (vars[key] !== undefined) throw new Error(`application variable "${key}" is managed by Fabrika`)
				if (secrets[key] !== undefined) throw new Error(`application secret "${key}" is managed by Fabrika`)
			}
			Object.assign(managedEnvironment, releaseContext.managedEnvironment)
		}
		const returnOrigins = await projectedReturnOrigins(deps.repositories.registry, app.id)
		const runLogs = new RunLogWriter(deps.logs, startedLogKey, run.id)
		let outcome: ProviderDeployOutcome
		try {
			if (ingestGap !== null) {
				runLogs.log(`operations ingest not injected: app has no active ingest config (${ingestGap})`)
				// A relay-backed provider re-flushes its own full buffer to this key, so the line survives
				// only in the control log there — flush first so ours can never land after a relay flush.
				await runLogs.flush()
			}
			await owner.refreshCancellation()
			owner.work.signal.throwIfAborted()
			const deployInput: ProviderDeployInput = {
				runId: run.id,
				app: registration.app,
				environment: registration.environment,
				secrets,
				vars,
				managedEnvironment,
				...(returnOrigins === undefined ? {} : { returnOrigins }),
				dryRun: message.dryRun === true,
				...(sourceBinding === undefined ? {} : { sourceBinding }),
				...(releaseContext?.artifactUpload === undefined ? {} : { artifactUpload: releaseContext.artifactUpload }),
				signal: abortController.signal,
				events: {
					log: (line) => runLogs.log(line),
					externalId: async (externalId, providerState) => {
						await owner.mutate(
							(guard) => deps.repositories.runs.recordInitialRunExternalId(runId, externalId, providerState, guard),
							providerState,
							true,
							async () => {
								const acceptedRun = await deps.repositories.runs.getRun(runId)
								owner.guard()
								if (deps.operations !== undefined && acceptedRun !== null && acceptedRun.cancel_requested_at === null) {
									await projectOperationsRun(deps.operations, acceptedRun, {
										dryRun: message.dryRun === true,
										phase: 'provider_accepted',
										artifactState: 'pending',
									})
								}
							},
						)
						await owner.refreshCancellation()
					},
					checkpoint: async (providerState) => {
						await owner.mutate((guard) => deps.repositories.runs.checkpointRunProviderState(runId, providerState, guard), providerState)
					},
				},
			}
			outcome = await deps.provider.deploy(deployInput)
		} finally {
			await runLogs.flush()
		}
		await owner.drain()
		await owner.refreshCancellation()
		if (owner.work.signal.aborted) {
			const settled = await settleRunCancellation(deps, owner).catch(() => null)
			return { runId, status: settled === null ? 'running' : 'skipped' }
		}
		if (outcome.state === 'running') return { runId, status: 'running' }
		if (!(await deps.repositories.runs.markRunFinished(run.id, outcome.state, outcome.exitCode ?? null, owner.guard()))) {
			owner.invalidate()
			return { runId: run.id, status: 'skipped' }
		}
		await projectTerminalRun(deps, run.id, message.dryRun === true, outcome.state, outcome.artifactState)
		return { runId: run.id, status: outcome.state }
	} catch (error) {
		await owner.drain().catch(() => {})
		if (owner.lost) return { runId, status: 'running' }
		const latest = await owner.refreshCancellation()
		if (latest?.cancel_requested_at !== null && latest?.cancel_requested_at !== undefined) {
			const settled = await settleRunCancellation(deps, owner).catch(() => null)
			return { runId, status: settled === null ? 'running' : 'skipped' }
		}
		if (owner.hasAccepted) return { runId, status: 'running' }
		console.error(`deploy run ${run.id} failed:`, error instanceof Error ? error.message : 'unknown error')
		if (await deps.repositories.runs.markRunFinished(run.id, 'failed', null, owner.guard())) {
			await projectTerminalRun(deps, run.id, message.dryRun === true, 'failed')
			return { runId: run.id, status: 'failed' }
		}
		owner.invalidate()
		return { runId: run.id, status: 'skipped' }
	} finally {
		await owner.close()
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

/**
 * Cancel provider-owned work and finish the run. Resolves to the run's terminal status, or null while the
 * provider has not settled. A run whose external work activated before the cancel took effect succeeds:
 * cancellation never implies rollback (ADR-0044).
 */
export async function settleRunCancellation(
	deps: Pick<RunDeps, 'repositories' | 'provider'>,
	owner: RunOwnership,
): Promise<'succeeded' | 'failed' | null> {
	await owner.drain()
	const cancelling = await owner.refreshCancellation()
	if (cancelling === null || cancelling.cancel_requested_at === null || !['pending', 'running'].includes(cancelling.status)) return null
	let outcome: 'succeeded' | 'failed' = 'failed'
	const appEnv = await deps.repositories.registry.getAppEnv(cancelling.app_id, cancelling.env)
	if (cancelling.external_run_id !== null) {
		if (deps.provider.cancel === undefined) return null
		if (appEnv === null) throw new Error(`provider environment ${cancelling.app_id}/${cancelling.env} disappeared during cancellation`)
		if (appEnv.provider !== deps.provider.id) {
			throw new Error(`provider environment ${cancelling.app_id}/${cancelling.env} changed owner during cancellation`)
		}
		const returnOrigins = await projectedReturnOrigins(deps.repositories.registry, cancelling.app_id)
		owner.guard()
		const result = await deps.provider.cancel({
			signal: owner.ownership.signal,
			runId: cancelling.id,
			externalId: cancelling.external_run_id,
			environment: await providerEnvironment(deps.repositories.registry, appEnv),
			startedAtMs: (cancelling.started_at ?? cancelling.created_at) * 1000,
			...(returnOrigins === undefined ? {} : { returnOrigins }),
			...(cancelling.provider_state_json === null
				? {}
				: { providerState: parseProviderJson(cancelling.provider_state_json, `provider state for run ${cancelling.id}`) }),
		})
		if (result.state === 'pending') return null
		outcome = result.outcome ?? 'failed'
	}
	await owner.mutate((guard) => deps.repositories.runs.markRunCancellationFinished(cancelling.id, outcome, guard))
	return outcome
}

export async function cancelDeploy(
	deps: Pick<RunDeps, 'repositories' | 'provider' | 'lock' | 'ownershipTiming'>,
	run: RunRow,
): Promise<void> {
	const cancelling = await deps.repositories.runs.beginRunCancellation(run.id)
	if (cancelling === null) return
	const owner = await RunOwnership.acquire(deps.repositories.runs, deps.lock, cancelling, deps.ownershipTiming)
	if (owner === null) return
	try {
		await settleRunCancellation(deps, owner)
	} finally {
		await owner.close()
	}
}
