import {
	appEnvironmentId,
	type ContractArtifact,
	FABRIKA_APP_ORIGIN,
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	FABRIKA_PROXY_SECRET,
	FABRIKA_TOKEN_KEYS,
	isFrameworkVariableName,
} from '@fabrika/auth-core'
import type { RunLogLine } from '@fabrika/control-contract'
import { OPERATIONS_MANAGED_ENVIRONMENT_KEYS, operationsManagedEnvironment } from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE } from '@fabrika/operations-contract/releases'
import type { BlobStore, DeployLocks, JobQueue } from '@fabrika/platform'
import {
	type ControlProvider,
	type ProviderApp,
	type ProviderDeployInput,
	type ProviderDeploymentNamespace,
	type ProviderDeployOutcome,
	type ProviderEnvelope,
	type ProviderEnvironment,
	ProviderInvocationAbort,
	type ProviderReconcileOutcome,
	type ProviderSourceBinding,
	type ProviderTerminalOutcome,
} from '@fabrika/provider-contract'
import { namespaceNotReady, redactNamespaceErrorText, republishUnderLease, unconfirmedUpdateRefusal } from './api/namespaces'
import { lifecycleEnvelopeSchema } from './api/provider-envelope'
import { publishRunSnapshot } from './approval/publish'
import { approvedProviderAccess, approvedSnapshot, type ProviderAccessFields } from './approval/snapshot'
import { connectorAddresses } from './connectors'
import {
	type AppEnvRow,
	type AppRow,
	type ControlRegistryRepository,
	type ControlRepositories,
	crossOriginsField,
	type DeploymentNamespaceRow,
	isUnconfirmedNamespaceUpdate,
	type OperationsCatalogRepository,
	parseProviderJson,
	type RunRepository,
	type RunRow,
	serializeProviderJson,
} from './db'
import { devLauncherRefusal, platformSourceEnvironment, platformSourceOrigin } from './dev/deploy'
import type { CommitSource } from './github/source/commit-files'
import { acquireLease, type Lease, type LeaseClock, type LeaseFence, namespaceLeaseKey, runLeaseKey } from './lease'
import {
	type InstallationMail,
	installationMailEnvironment,
	installationMailSecrets,
	NO_INSTALLATION_MAIL,
	platformMailEnvironment,
	platformMailOrigin,
	relaysInstallationMail,
} from './mail-transport'
import { type MembershipTransportPort, needsMembershipTransport } from './membership-transport'
import { type OperationsReleaseProjectionDeps, projectOperationsRun } from './operations-releases'
import type { PlatformTransportPort } from './platform-transport'
import type { ProxySecrets } from './proxy-secret'
import { projectedReturnOrigins } from './return-origins'
import { appSecretPurpose, type SecretResolver } from './secret-resolver'
import { longestTokenLifetime, type TokenKeysPort } from './token-keys'
import { declaredConnectors, declaredWorkloads, type WorkloadCredentialsPort } from './workload-credentials'

export type RunOutcome = ProviderTerminalOutcome

/** Everything the provider-neutral lifecycle needs. */
export interface RunDeps {
	repositories: ControlRepositories
	secrets: SecretResolver
	provider: ControlProvider
	lock: DeployLocks
	leaseClock?: LeaseClock
	/** Where a namespace rebuild a deploy could not settle is handed to a `reconcile` job. */
	queue?: Pick<JobQueue<ControlJobMessage>, 'send'>
	logs: Pick<BlobStore, 'put'>
	/** The run-log store a settlement appends to after the run's own writer is gone; absent, its lines go to the console only. */
	runLogs?: Pick<BlobStore, 'get' | 'put'>
	/**
	 * Where a run's snapshot is read at its pinned commit (ADR-0050). A run with a pinned commit and no commit source
	 * fails rather than publish access it could not read.
	 */
	commits?: CommitSource
	operations?: OperationsReleaseProjectionDeps
	/**
	 * This installation's IAM issuer, delivered to every application it deploys (ADR-0035). Optional
	 * because a composition may not know its own public IAM origin; then the name is REMOVED from the
	 * service rather than left stale, and an app that requires it fails its own boot, loudly.
	 */
	iamIssuer?: string
	/** The proxy secret of an environment behind a namespace proxy (ADR-0022 rule 5); absent without a vault. */
	proxySecrets?: ProxySecrets
	/**
	 * The keys of the approved contract's jobs and webhooks (ADR-0022 "Principal kinds"); absent without a vault, an IAM
	 * issuer or a provisioning key, and then a contract that declares one does not deploy.
	 */
	workloadCredentials?: WorkloadCredentialsPort
	/**
	 * The membership transport key of an environment behind a namespace proxy, which has no IAM binding (ADR-0022 rule 6);
	 * absent without a vault, an IAM issuer or a provisioning key, and then a contract that needs one does not deploy there.
	 */
	membershipTransport?: MembershipTransportPort
	/**
	 * The keys of each environment's signed tokens, sealed in the vault; absent without a vault, and then a contract that
	 * declares a token purpose does not deploy.
	 */
	tokenKeys?: TokenKeysPort
	/**
	 * The installation's mail transport; absent means none, and then a job that declares `mailer: 'installation'` gets
	 * `FABRIKA_EMAIL_PROVIDER=none`. An invalid one refuses only the deploys that need it.
	 */
	mailTransport?: InstallationMail
	/**
	 * The platform transport keys an environment behind a namespace proxy calls Control's relay with; absent without a
	 * vault, and then a contract whose job sends through the relay does not deploy there.
	 */
	platformTransport?: PlatformTransportPort
	/**
	 * Control's public origin, where an application behind a namespace proxy reaches the relay; absent when
	 * `FABRIKA_CONTROL_DOMAIN` names none, and then a contract whose job sends through the relay does not deploy there.
	 */
	controlOrigin?: string
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

const REDACTED = '[redacted]'

/**
 * `text` with every known secret value replaced, longest first so a secret that contains another stays whole. Provider
 * output can carry a value the application printed, so a line is redacted before it is printed or stored.
 */
export function redactKnownSecrets(text: string, secrets: readonly string[]): string {
	return [...secrets].filter((secret) => secret !== '').sort((a, b) => b.length - a.length).reduce(
		(redacted, secret) => redacted.replaceAll(secret, REDACTED),
		text,
	)
}

class RunLogWriter {
	readonly #lines: RunLogLine[] = []
	#writeQueue: Promise<void> = Promise.resolve()
	/** The secret values this run handed the provider. */
	#secrets: readonly string[] = []

	constructor(
		private readonly logs: Pick<BlobStore, 'put'>,
		private readonly key: string,
		private readonly runId: string,
	) {}

	/** Redact these values from every later line; the run's publication logs before its secrets are resolved. */
	redact(secrets: readonly string[]): void {
		this.#secrets = [...this.#secrets, ...secrets]
	}

	log(line: string): void {
		const text = redactKnownSecrets(line, this.#secrets)
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

/** The app's private-source selector (ADR-0029); undefined for a public source. */
const loadSourceBinding = async (deps: Pick<RunDeps, 'repositories' | 'provider'>, app: AppRow): Promise<ProviderSourceBinding | undefined> => {
	if (deps.provider.source === undefined) {
		if (app.github_connection_id !== null || app.github_installation_id !== null) {
			throw new Error(`provider "${deps.provider.id}" cannot deploy a private source`)
		}
		return undefined
	}
	return (await deps.repositories.registry.getSourceBinding(app.id)) ?? undefined
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
	namespace: ProviderDeploymentNamespace | undefined,
	access: ProviderAccessFields,
): ProviderEnvironment => ({
	appId: row.app_id,
	env: row.env,
	...(row.kind === 'dev' ? { kind: 'dev' } : {}),
	...(row.domain === null ? {} : { domain: row.domain }),
	...(row.public_origin === null ? {} : { publicOrigin: row.public_origin }),
	...crossOriginsField(row),
	...(namespace === undefined ? {} : { namespace }),
	target: parseProviderEnvelope(row.provider_target_json, `target for ${row.app_id}/${row.env}`),
	artifact: parseProviderEnvelope(row.provider_artifact_json, `artifact for ${row.app_id}/${row.env}`),
	...access,
})

/**
 * Hydrate one persisted environment at the generic control-provider boundary.
 *
 * Deploys require a ready namespace. Cancellation, reconciliation, and managed-secret cleanup still
 * need the original coordinates while a namespace is degraded, so those callers omit that guard.
 */
export const providerEnvironment = async (
	repositories: Pick<ControlRepositories, 'registry' | 'runs'>,
	row: AppEnvRow,
	options: { requireReadyNamespace?: boolean } = {},
): Promise<ProviderEnvironment> => {
	let namespace: ProviderDeploymentNamespace | undefined
	if (row.namespace_id !== null) {
		const stored = await repositories.registry.getDeploymentNamespace(row.namespace_id)
		if (stored === null) {
			throw new Error(`deployment namespace "${row.namespace_id}" is missing`)
		}
		if (stored.provider !== row.provider || stored.env !== row.env) {
			throw new Error(`deployment namespace "${stored.id}" has incompatible provider coordinates`)
		}
		if (stored.exclusive_app_id !== null && stored.exclusive_app_id !== row.app_id) {
			throw new Error(`deployment namespace "${stored.id}" is exclusive to another app`)
		}
		if (options.requireReadyNamespace === true && isUnconfirmedNamespaceUpdate(stored)) {
			throw new Error(unconfirmedUpdateRefusal(stored.id))
		}
		if (options.requireReadyNamespace === true && stored.state !== 'ready') {
			throw new Error(namespaceNotReady(stored))
		}
		namespace = providerNamespace(stored)
	}
	// The access a provider publishes is the approved snapshot's, never the artifact's (ADR-0050).
	const environment = storedProviderEnvironment(row, namespace, approvedProviderAccess(row))
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
const assertUnmanagedNames = (kind: 'variable' | 'secret', appId: string, names: readonly string[]): void => {
	const reserved = names.find(isFrameworkVariableName)
	if (reserved === undefined) return
	// A name a release before this one accepted (a new reserved family) lands here: say how to get past it.
	const removal = `\`fabrika control apps ${kind}s delete --app=${appId} --name=${reserved}\` (add --env=<env> for one environment's)`
	throw new Error(
		`application ${kind} "${reserved}" is managed by Fabrika: delete it with ${removal}, rename it if the code reads it, and deploy again`,
	)
}

/** The row reached a terminal state before this invocation's write: nothing is left for it to do. */
class RunSettled extends Error {}

/**
 * One invocation's hold on a run: its `<app>:<env>` lease and the signal its work runs under. `work`
 * aborts with `cancel_requested` when a step boundary reads the request (never a poll, ADR-0044), and
 * with `lease_lost` when the lease goes.
 */
export class RunInvocation {
	readonly work = new AbortController()

	private constructor(readonly lease: Lease, private readonly runs: RunRepository, readonly runId: string) {
		const follow = (): void => this.work.abort(lease.signal.reason)
		if (lease.signal.aborted) follow()
		else lease.signal.addEventListener('abort', follow, { once: true })
	}

	static async acquire(deps: Pick<RunDeps, 'repositories' | 'lock' | 'leaseClock'>, candidate: RunRow): Promise<RunInvocation | null> {
		const lease = await acquireLease(deps.lock, runLeaseKey(candidate.app_id, candidate.env), deps.leaseClock)
		return lease === null ? null : new RunInvocation(lease, deps.repositories.runs, candidate.id)
	}

	/** Another run of the same environment, under the same lease. */
	forRun(runId: string): RunInvocation {
		return new RunInvocation(this.lease, this.runs, runId)
	}

	get lost(): boolean {
		return this.lease.signal.aborted
	}

	get cancelled(): boolean {
		const reason: unknown = this.work.signal.reason
		return reason instanceof ProviderInvocationAbort && reason.kind === 'cancel_requested'
	}

	/** Read the row under the lease; a recorded cancellation request aborts `work`. */
	async read(): Promise<RunRow | null> {
		const row = await this.runs.getRun(this.runId)
		this.lease.assertHeld()
		if (row !== null && row.cancel_requested_at !== null && !this.work.signal.aborted) {
			this.work.abort(new ProviderInvocationAbort('cancel_requested'))
		}
		return row
	}

	/** A step boundary: rejects with `lease_lost`, `cancel_requested` or `RunSettled`, else answers the active row. */
	async boundary(): Promise<RunRow> {
		const row = await this.read()
		if (row === null || (row.status !== 'pending' && row.status !== 'running')) throw new RunSettled(`run ${this.runId} is settled`)
		if (this.cancelled) throw new ProviderInvocationAbort('cancel_requested')
		return row
	}

	/** One fenced write. A refused one is explained by the row; a throwing one leaves the outcome unknown. */
	async write(mutation: (fence: LeaseFence) => Promise<boolean>): Promise<void> {
		const fence = this.lease.fence()
		let changed: boolean
		try {
			changed = await mutation(fence)
		} catch (error) {
			// The row may or may not have changed, so this invocation must not write again.
			this.lease.abandon()
			throw error
		}
		if (changed) return
		await this.boundary()
		throw new Error(`run ${this.runId} refused a lifecycle write`)
	}

	release(): Promise<void> {
		return this.lease.release()
	}
}

type DeployStatus = 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'skipped' | 'deferred'

/**
 * Execute one queued deploy through the statically selected provider.
 *
 * Core owns locking and terminal database transitions. The provider owns source delivery, deploy
 * mechanics, external operation ids, reconciliation, and provider-managed secret semantics.
 */
export async function executeDeploy(deps: RunDeps, message: DeployJobMessage): Promise<{ runId: string; status: DeployStatus }> {
	const candidate = await deps.repositories.runs.getRun(message.runId)
	if (candidate === null) {
		return { runId: message.runId, status: 'skipped' }
	}
	if (candidate.status !== 'pending') {
		return { runId: candidate.id, status: 'skipped' }
	}

	const invocation = await RunInvocation.acquire(deps, candidate)
	if (invocation === null) {
		return { runId: candidate.id, status: 'deferred' }
	}
	const runId = candidate.id
	const dryRun = message.dryRun === true
	const runs = deps.repositories.runs
	let accepted = false
	// Lock order is always app/env, then namespace: a namespace path never takes an app/env lease.
	let namespaceLease: Lease | null = null
	let logWriter: RunLogWriter | null = null

	try {
		const run = await invocation.read()
		if (run === null || run.status !== 'pending') return { runId, status: 'skipped' }
		if (invocation.cancelled) return await settleCancelledInvocation(deps, invocation)
		const namespaceId = dryRun || deps.provider.namespaces?.republish === undefined
			? null
			: (await deps.repositories.registry.getAppEnv(run.app_id, run.env))?.namespace_id ?? null
		if (namespaceId !== null) {
			namespaceLease = await acquireLease(deps.lock, namespaceLeaseKey(namespaceId), deps.leaseClock)
			if (namespaceLease === null) return { runId, status: 'deferred' }
		}
		if (!(await startRun(deps, invocation, run))) {
			const latest = await runs.getRun(runId)
			return { runId, status: latest?.status === 'pending' ? 'deferred' : 'skipped' }
		}
		let startedRun = await invocation.boundary()
		if (startedRun.log_key === null) throw new Error('started run has no log key')
		const startedLogKey = startedRun.log_key
		const runLogs = new RunLogWriter(deps.logs, startedLogKey, runId)
		logWriter = runLogs
		const app = await deps.repositories.registry.getApp(run.app_id)
		const appEnv = await deps.repositories.registry.getAppEnv(run.app_id, run.env)
		if (app === null || appEnv === null) {
			await invocation.write((fence) => runs.markRunFinished(runId, 'failed', null, fence))
			await projectTerminalRun(deps, runId, dryRun, 'failed')
			return { runId, status: 'failed' }
		}
		if (appEnv.provider !== deps.provider.id) {
			throw new Error(
				`configured provider "${deps.provider.id}" cannot deploy ${app.id}/${appEnv.env} owned by "${appEnv.provider}"`,
			)
		}
		const sourceBinding = await loadSourceBinding(deps, app)
		const appInput = providerApp(app, run)
		const environmentInput = await providerEnvironment(deps.repositories, appEnv, { requireReadyNamespace: true })
		// The row the deploy's access was read from: its approved snapshot also names the application's framework release.
		let approvedRow = appEnv
		let registration = deps.provider.normalizeRegistration?.({ app: appInput, environment: environmentInput })
			?? { app: appInput, environment: environmentInput }
		await assertNamespaceResourceClaims(deps.repositories.registry, deps.provider, registration)
		const resolveSource = deps.provider.resolveSource
		if (!dryRun && resolveSource !== undefined) {
			await invocation.boundary()
			const expectedCommitSha = startedRun.commit_sha === null
				? undefined
				: immutableGitObjectId(startedRun.commit_sha, 'recorded commit')
			const resolution = await resolveSource({
				runId,
				app: registration.app,
				environment: registration.environment,
				...(expectedCommitSha === undefined ? {} : { expectedCommitSha }),
				...(sourceBinding === undefined ? {} : { sourceBinding }),
				signal: invocation.work.signal,
			})
			const commitSha = immutableGitObjectId(resolution.commitSha, 'resolved commit')
			await invocation.boundary()
			if (expectedCommitSha !== undefined && commitSha !== expectedCommitSha) {
				throw new Error('resolved commit does not match the recorded commit')
			}
			await invocation.write((fence) => runs.setRunCommit(runId, commitSha, fence))
			startedRun = await invocation.boundary()
			registration = { ...registration, app: providerAppAtCommit(registration.app, commitSha) }
			// A pending change is published nowhere (ADR-0050): parked here, the run reaches no proxy and no IAM.
			const commits = deps.commits
			if (commits === undefined) throw new Error('no commit source is configured to read the run snapshot')
			const publication = await publishRunSnapshot({ repositories: deps.repositories, commits }, {
				signal: invocation.work.signal,
				boundary: () => invocation.boundary(),
				write: (mutation) => invocation.write(mutation),
				fence: () => invocation.lease.fence(),
			}, {
				run: startedRun,
				app,
				root: deps.provider.applicationRoot === undefined ? '' : deps.provider.applicationRoot(registration.app.source),
				commitSha,
				...(sourceBinding === undefined ? {} : { sourceBinding }),
				validateAccess: async (access, row) => {
					if (deps.provider.validateAccess === undefined) return
					const environment = await providerEnvironment(deps.repositories, row, { requireReadyNamespace: true })
					deps.provider.validateAccess({ environment, access })
				},
				log: (line) => runLogs.log(line),
			})
			if (publication.kind === 'parked') {
				await runLogs.flush()
				return { runId, status: 'awaiting_approval' }
			}
			startedRun = await invocation.boundary()
			approvedRow = await currentAppEnv(deps.repositories, appEnv)
			registration = { ...registration, environment: withAccess(registration.environment, approvedProviderAccess(approvedRow)) }
		}
		const releaseContext = deps.operations === undefined
			? null
			: await projectOperationsRun(deps.operations, startedRun, {
				dryRun,
				phase: 'started',
				artifactState: 'pending',
			})

		const vars = await resolveVars(deps.repositories.registry, app.id, appEnv.env)
		assertUnmanagedNames('variable', app.id, Object.keys(vars))
		// Resolved here rather than at the provider call, so a reserved secret name fails before any effect.
		const secrets = await resolveSecrets(deps, app.id, appEnv.env)
		assertUnmanagedNames('secret', app.id, Object.keys(secrets))
		const managedEnvironment: Record<string, string | null> = {
			[FABRIKA_RELEASE]: null,
			[FABRIKA_IAM_ISSUER]: null,
			// The token audience the application verifies; the proxy in front of it mints for the same id.
			[FABRIKA_IAM_APP_ID]: appEnvironmentId(app.id, appEnv.env),
		}
		for (const key of OPERATIONS_MANAGED_ENVIRONMENT_KEYS) managedEnvironment[key] = null
		// Behind a namespace proxy the hop to the application and to IAM is no service binding.
		const namespaceProxy = appEnv.namespace_id !== null && deps.provider.namespaces?.republish !== undefined
		// Only a namespace proxy authenticates itself with a secret; a dry run generates none.
		managedEnvironment[FABRIKA_PROXY_SECRET] = !dryRun && namespaceProxy ? (await deps.proxySecrets?.forAppEnv(app.id, appEnv.env)) ?? null : null
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
		// From the approved contract only, like every other access the deploy publishes (ADR-0050); a dry run issues none.
		const approvedContract = registration.environment.access?.contract ?? null
		const relayedMail = relaysMail(deps.provider, approvedRow)
		const mailEnvironment = relayedMail ? {} : installationMailEnvironment(deps.mailTransport ?? NO_INSTALLATION_MAIL, approvedContract)
		Object.assign(managedEnvironment, mailEnvironment)
		const workloadKeys = dryRun ? {} : await reconcileWorkloadKeys(deps.workloadCredentials, app.id, appEnv.env, approvedContract)
		Object.assign(managedEnvironment, workloadKeys, await connectorAddresses(deps.repositories.registry, appEnv.env, approvedContract))
		const membershipKey = dryRun
			? null
			: await reconcileMembershipKey(deps, app.id, appEnv.env, namespaceProxy && needsMembershipTransport(approvedContract))
		managedEnvironment[MEMBERSHIP_URL_VARIABLE] = membershipKey === null ? null : membershipTransportOrigin(deps.iamIssuer)
		managedEnvironment[MEMBERSHIP_KEY_VARIABLE] = membershipKey
		const relayOrigin = relayedMail ? platformMailOrigin(deps.controlOrigin) : null
		// A version that no longer relays keeps the running one's key valid until it runs itself (`retirePlatformKeys`).
		const platformMailKey = dryRun || !relayedMail ? null : await issuePlatformMailKey(deps, app.id, appEnv.env)
		if (relayOrigin !== null) Object.assign(managedEnvironment, platformMailEnvironment(relayOrigin, platformMailKey))
		const platformSourceKey = appEnv.kind === 'dev' ? await devSourceKey(deps, approvedRow, dryRun) : null
		if (appEnv.kind === 'dev') Object.assign(managedEnvironment, platformSourceEnvironment(platformSourceOrigin(deps.controlOrigin), platformSourceKey))
		// The canonical origin `ctx.url` builds links on; `null` removes a stale one from an environment that has none.
		managedEnvironment[FABRIKA_APP_ORIGIN] = appEnv.public_origin === null || appEnv.public_origin === '' ? null : appEnv.public_origin
		const tokenKeys = dryRun ? null : await reconcileTokenKeys(deps.tokenKeys, app.id, appEnv.env, approvedContract)
		managedEnvironment[FABRIKA_TOKEN_KEYS] = tokenKeys
		const returnOrigins = await projectedReturnOrigins(deps.repositories.registry, app.id, appEnv.env)
		runLogs.redact([
			...Object.values(secrets),
			managedEnvironment[FABRIKA_PROXY_SECRET] ?? '',
			...Object.values(workloadKeys),
			membershipKey ?? '',
			platformMailKey ?? '',
			platformSourceKey ?? '',
			tokenKeys ?? '',
			...installationMailSecrets(deps.mailTransport ?? NO_INSTALLATION_MAIL, mailEnvironment),
			// A Zerops build holds the source-map bearer, and the provider relays the build's log.
			releaseContext?.artifactUpload?.bearer ?? '',
		])
		let outcome: ProviderDeployOutcome
		try {
			if (ingestGap !== null) {
				runLogs.log(`operations ingest not injected: app has no active ingest config (${ingestGap})`)
			}
			// A relay-backed provider re-flushes its own full buffer to this key, so these lines survive only
			// in the control log there — flush first so ours can never land after a relay flush.
			await runLogs.flush()
			await invocation.boundary()
			if (namespaceLease !== null && namespaceId !== null) {
				const queue = deps.queue
				if (queue === undefined) throw new Error('a namespace republish needs the control queue')
				// The proxy routes what the registry holds before the app it fronts changes (ADR-0022).
				await republishUnderLease({ ...deps, queue }, namespaceLease, namespaceId, {
					wait: 'active',
					signal: invocation.work.signal,
					boundary: async () => {
						await invocation.boundary()
					},
				})
				await namespaceLease.release()
				namespaceLease = null
			}
			const deployInput: ProviderDeployInput = {
				runId,
				app: registration.app,
				environment: registration.environment,
				secrets,
				vars,
				managedEnvironment,
				...(returnOrigins === undefined ? {} : { returnOrigins }),
				dryRun,
				...(sourceBinding === undefined ? {} : { sourceBinding }),
				...(releaseContext?.artifactUpload === undefined ? {} : { artifactUpload: releaseContext.artifactUpload }),
				signal: invocation.work.signal,
				events: {
					log: (line) => runLogs.log(line),
					externalId: async (externalId, providerState) => {
						if (providerState !== undefined) serializeProviderJson(providerState)
						await invocation.write((fence) => runs.recordInitialRunExternalId(runId, externalId, providerState, fence))
						accepted = true
						const acceptedRun = await invocation.boundary()
						if (deps.operations !== undefined) {
							await projectOperationsRun(deps.operations, acceptedRun, { dryRun, phase: 'provider_accepted', artifactState: 'pending' })
						}
					},
					checkpoint: async (providerState) => {
						serializeProviderJson(providerState)
						await invocation.write((fence) => runs.checkpointRunProviderState(runId, providerState, fence))
						await invocation.boundary()
					},
					boundary: async () => {
						await invocation.boundary()
					},
				},
			}
			outcome = await deps.provider.deploy(deployInput)
		} finally {
			await runLogs.flush()
		}
		await invocation.boundary()
		if (outcome.state === 'running') return { runId, status: 'running' }
		const state = outcome.state
		await invocation.write((fence) => runs.markRunFinished(runId, state, outcome.exitCode ?? null, fence))
		if (state === 'succeeded' && !dryRun) await retirePlatformKeys(deps, approvedRow, runId)
		await projectTerminalRun(deps, runId, dryRun, state, outcome.artifactState)
		return { runId, status: state }
	} catch (error) {
		if (error instanceof RunSettled) return { runId, status: 'skipped' }
		if (!invocation.lost && !invocation.cancelled) await invocation.boundary().catch(() => {})
		// Lease loss stops this invocation's effects; the next holder settles what it recorded (ADR-0044).
		if (invocation.lost) return { runId, status: 'running' }
		if (invocation.cancelled) return await settleCancelledInvocation(deps, invocation)
		if (accepted) return { runId, status: 'running' }
		const reason = failureReason(error)
		console.error(`deploy run ${runId} failed: ${reason}`)
		// The run log is where `runs log` and the console read a failure from, so it lands there before the row turns failed.
		logWriter?.log(`deploy failed: ${reason}`)
		await logWriter?.flush()
		try {
			await invocation.write((fence) => runs.markRunFinished(runId, 'failed', null, fence))
		} catch (refused) {
			return { runId, status: refused instanceof RunSettled ? 'skipped' : 'running' }
		}
		await projectTerminalRun(deps, runId, dryRun, 'failed')
		return { runId, status: 'failed' }
	} finally {
		await logWriter?.flush()
		await namespaceLease?.release()
		await invocation.release()
	}
}

/** A failed run's cause as one credential-free line: never the error object, which can carry a clone URL with a token. */
function failureReason(error: unknown): string {
	const message = error instanceof Error ? error.message : ''
	return redactNamespaceErrorText(message, { cap: false }) || 'unknown error'
}

/** The environment's approved access as the provider reads it, read again after this run's publication. */
async function reconcileWorkloadKeys(
	credentials: WorkloadCredentialsPort | undefined,
	appId: string,
	env: string,
	contract: ContractArtifact | null,
): Promise<Readonly<Record<string, string>>> {
	if (credentials !== undefined) {
		return credentials.reconcile(appId, env, contract)
	}
	if (declaredWorkloads(contract).size > 0 || declaredConnectors(contract).size > 0) {
		throw new Error(
			'the contract declares jobs, webhooks, public procedures or imports, and this installation cannot issue their keys (it needs FABRIKA_CONTROL_VAULT_KEY, FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY)',
		)
	}
	return {}
}

/** The signing and verifying keys of the contract's token purposes; `null` for a contract that declares none. */
async function reconcileTokenKeys(
	keys: TokenKeysPort | undefined,
	appId: string,
	env: string,
	contract: ContractArtifact | null,
): Promise<string | null> {
	if (keys !== undefined) {
		return keys.reconcile(appId, env, contract)
	}
	if (longestTokenLifetime(contract) !== null) {
		throw new Error('the contract declares token purposes, and this installation cannot keep their keys (it needs FABRIKA_CONTROL_VAULT_KEY)')
	}
	return null
}

/** IAM's membership transport for an application without an IAM binding: its URL (IAM's public origin) and its key. */
const MEMBERSHIP_URL_VARIABLE = 'FABRIKA_IAM_RPC_URL'
const MEMBERSHIP_KEY_VARIABLE = 'FABRIKA_IAM_RPC_KEY'

async function reconcileMembershipKey(
	deps: Pick<RunDeps, 'membershipTransport'>,
	appId: string,
	env: string,
	needed: boolean,
): Promise<string | null> {
	if (deps.membershipTransport !== undefined) {
		return deps.membershipTransport.reconcile(appId, env, needed)
	}
	if (needed) {
		throw new Error(
			'the contract manages members, creates scopes or issues share links, and this installation cannot issue the membership transport key (it needs FABRIKA_CONTROL_VAULT_KEY, FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY)',
		)
	}
	return null
}

async function issuePlatformMailKey(deps: Pick<RunDeps, 'platformTransport'>, appId: string, env: string): Promise<string> {
	if (deps.platformTransport === undefined) {
		throw new Error(
			"the contract's jobs send mail through the installation's relay, and this installation cannot issue the platform transport key (it needs FABRIKA_CONTROL_VAULT_KEY)",
		)
	}
	return deps.platformTransport.issue(appId, env, 'mail')
}

/**
 * The `source` key of a `dev` environment, after the refusal of a framework release without the launcher. The key is the
 * environment's for as long as it exists: a dev environment's kind never changes. A dry run issues none.
 */
async function devSourceKey(deps: Pick<RunDeps, 'platformTransport'>, appEnv: AppEnvRow, dryRun: boolean): Promise<string | null> {
	const refusal = devLauncherRefusal(approvedSnapshot(appEnv).snapshot.framework)
	if (refusal !== null) throw new Error(refusal)
	if (dryRun) return null
	if (deps.platformTransport === undefined) {
		throw new Error('a dev environment needs the platform transport key, and this installation cannot issue it (it needs FABRIKA_CONTROL_VAULT_KEY)')
	}
	return deps.platformTransport.issue(appEnv.app_id, appEnv.env, 'source')
}

/** Whether the environment's approved version sends its jobs' mail through Control's relay: only behind a namespace proxy. */
function relaysMail(provider: ControlProvider, appEnv: AppEnvRow): boolean {
	const namespaceProxy = appEnv.namespace_id !== null && provider.namespaces?.republish !== undefined
	const { snapshot } = approvedSnapshot(appEnv)
	return namespaceProxy && relaysInstallationMail(snapshot.contract, snapshot.framework)
}

/**
 * Revoke the relay keys of an environment whose version now runs without the relay. Only a succeeded run does: until
 * its version runs, the previous one sends with its key. `appEnv` is the run's own publication, which no other run can
 * replace before this one settles. A failure leaves the keys to their expiry or the next succeeded run.
 */
async function retirePlatformKeys(deps: Pick<RunDeps, 'platformTransport' | 'provider'>, appEnv: AppEnvRow, runId: string): Promise<void> {
	if (deps.platformTransport === undefined || relaysMail(deps.provider, appEnv)) return
	try {
		await deps.platformTransport.revoke(appEnv.app_id, appEnv.env, 'mail')
	} catch {
		console.error(`deploy run ${runId}: revoking the relay keys its version no longer needs failed; the next succeeded run retries`)
	}
}

function membershipTransportOrigin(iamIssuer: string | undefined): string {
	const origin = iamIssuer?.trim() ?? ''
	if (origin === '') {
		throw new Error("the membership transport needs the installation's IAM issuer, and this installation names none")
	}
	return origin
}

async function currentAppEnv(repositories: ControlRepositories, appEnv: AppEnvRow): Promise<AppEnvRow> {
	const row = await repositories.registry.getAppEnv(appEnv.app_id, appEnv.env)
	if (row === null) throw new Error(`app environment ${appEnv.app_id}/${appEnv.env} disappeared during the deploy`)
	return row
}

function withAccess(environment: ProviderEnvironment, access: ProviderAccessFields): ProviderEnvironment {
	const { access: _previous, ...rest } = environment
	return { ...rest, ...access }
}

async function settleCancelledInvocation(
	deps: Pick<RunDeps, 'repositories' | 'provider' | 'platformTransport'>,
	invocation: RunInvocation,
): Promise<{ runId: string; status: DeployStatus }> {
	const settled = await settleRunCancellation(deps, invocation).catch(() => null)
	return { runId: invocation.runId, status: settled === null ? 'running' : 'skipped' }
}

/**
 * Move the run to `running`. A run of the same environment left `running` by a dead holder is settled
 * first under this same lease, so the next deploy does not wait for the cron (ADR-0044).
 */
async function startRun(deps: RunDeps, invocation: RunInvocation, run: RunRow): Promise<boolean> {
	const runs = deps.repositories.runs
	if (await runs.markRunStarted(run.id, logsKey(run.id), invocation.lease.fence())) return true
	const blocking = (await runs.listInFlightRuns(deps.provider.id)).find((other) =>
		other.app_id === run.app_id && other.env === run.env && other.status === 'running' && other.id !== run.id
	)
	if (blocking === undefined) return false
	const settled = await settleUnfinishedRun(deps, invocation.forRun(blocking.id)).catch(() => null)
	if (settled !== 'succeeded' && settled !== 'failed') return false
	return runs.markRunStarted(run.id, logsKey(run.id), invocation.lease.fence())
}

export type RunSettleDeps = Pick<RunDeps, 'repositories' | 'provider' | 'operations' | 'runLogs' | 'platformTransport'> & {
	projectTerminal?: typeof projectTerminalRun
}

/** The reason a run settled by a new owner ends with: its holder stopped before any provider accepted the work. */
export const RUN_INTERRUPTED_REASON =
	"deploy interrupted: Control restarted (or lost the run's lease) while the run was in progress, before the provider accepted it; run the deploy again"

/** `untracked`: the provider cannot observe accepted work, so only a cancellation can settle it. */
export type RunSettlement = 'succeeded' | 'failed' | 'running' | 'waiting' | 'untracked'

async function projectSettled(
	deps: RunSettleDeps,
	runId: string,
	state: 'failed' | 'succeeded',
	outcome: Pick<ProviderReconcileOutcome, 'artifactState' | 'dryRun'> = {},
): Promise<void> {
	try {
		await (deps.projectTerminal ?? projectTerminalRun)(deps, runId, outcome.dryRun === true, state, outcome.artifactState)
	} catch {
		console.error(`provider reconcile terminal projection failed for run ${runId}`)
	}
}

/** Append one meta line to a run's log, keeping what the provider's executor already wrote there. */
async function appendRunLog(logs: Pick<BlobStore, 'get' | 'put'>, key: string, text: string): Promise<void> {
	const existing = await logs.get(key)
	const before = existing === null ? '' : await existing.text()
	const line: RunLogLine = { ts: Date.now(), stream: 'meta', text }
	const separator = before === '' || before.endsWith('\n') ? '' : '\n'
	await logs.put(key, `${before}${separator}${JSON.stringify(line)}\n`)
}

/**
 * Settle one unfinished run under its environment's lease without replaying any step: settle its
 * cancellation, fail it when no provider accepted it, or reconcile the accepted work. `null` when the
 * run is no longer active.
 */
export async function settleUnfinishedRun(deps: RunSettleDeps, invocation: RunInvocation): Promise<RunSettlement | null> {
	let cancelling = false
	const settleCancellation = async (): Promise<RunSettlement> => {
		cancelling = true
		const settled = await settleRunCancellation(deps, invocation)
		if (settled === null) return 'running'
		await projectSettled(deps, invocation.runId, settled)
		return settled
	}
	try {
		const run = await invocation.read()
		if (run === null || (run.status !== 'pending' && run.status !== 'running')) return null
		if (invocation.cancelled) return await settleCancellation()
		if (run.external_run_id === null) {
			if (run.status === 'pending') return 'waiting'
			await logSettlement(deps, run, RUN_INTERRUPTED_REASON)
			await invocation.write((fence) => deps.repositories.runs.markRunFinished(run.id, 'failed', null, fence))
			await projectSettled(deps, run.id, 'failed')
			return 'failed'
		}
		const reconcile = deps.provider.reconcile
		if (reconcile === undefined) return 'untracked'
		const appEnv = await deps.repositories.registry.getAppEnv(run.app_id, run.env)
		if (appEnv === null || appEnv.provider !== deps.provider.id) throw new Error('provider environment disappeared or changed owner')
		const returnOrigins = await projectedReturnOrigins(deps.repositories.registry, run.app_id, run.env)
		const environment = await providerEnvironment(deps.repositories, appEnv)
		await invocation.boundary()
		const outcome = await reconcile({
			runId: run.id,
			externalId: run.external_run_id,
			environment,
			signal: invocation.work.signal,
			...(run.provider_state_json === null ? {} : { providerState: parseProviderJson(run.provider_state_json, 'provider state') }),
			startedAtMs: (run.started_at ?? run.created_at) * 1000,
			...(returnOrigins === undefined ? {} : { returnOrigins }),
			log: (line) => logSettlement(deps, run, line),
		})
		await invocation.boundary()
		if (outcome.state === 'running') return 'running'
		const state = outcome.state
		await invocation.write((fence) => deps.repositories.runs.markRunFinished(run.id, state, outcome.exitCode ?? null, fence))
		if (state === 'succeeded' && outcome.dryRun !== true) await retirePlatformKeys(deps, appEnv, run.id)
		await projectSettled(deps, run.id, state, outcome)
		return state
	} catch (error) {
		// A cancellation read at a boundary is settled now; a settlement that itself failed waits for the next pass.
		if (!invocation.lost && invocation.cancelled && !cancelling) return await settleCancellation()
		throw error
	}
}

/** One line of a settlement, to the console and, when the run has a log, appended to it. A failed write is not the run's outcome. */
export async function logSettlement(deps: Pick<RunDeps, 'runLogs'>, run: Pick<RunRow, 'id' | 'log_key'>, line: string): Promise<void> {
	console.info(`deploy run ${run.id}: ${line}`)
	if (deps.runLogs === undefined || run.log_key === null) return
	await appendRunLog(deps.runLogs, run.log_key, line).catch(() => console.error(`deploy run ${run.id}: failed to persist log output`))
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
	deps: Pick<RunDeps, 'repositories' | 'provider' | 'platformTransport'>,
	invocation: RunInvocation,
): Promise<'succeeded' | 'failed' | null> {
	const cancelling = await invocation.read()
	if (cancelling === null || cancelling.cancel_requested_at === null || !['pending', 'running', 'awaiting_approval'].includes(cancelling.status)) {
		return null
	}
	let outcome: 'succeeded' | 'failed' = 'failed'
	let activated: AppEnvRow | null = null
	if (cancelling.external_run_id !== null) {
		if (deps.provider.cancel === undefined) return null
		const appEnv = await deps.repositories.registry.getAppEnv(cancelling.app_id, cancelling.env)
		if (appEnv === null) throw new Error(`provider environment ${cancelling.app_id}/${cancelling.env} disappeared during cancellation`)
		if (appEnv.provider !== deps.provider.id) {
			throw new Error(`provider environment ${cancelling.app_id}/${cancelling.env} changed owner during cancellation`)
		}
		const returnOrigins = await projectedReturnOrigins(deps.repositories.registry, cancelling.app_id, cancelling.env)
		const environment = await providerEnvironment(deps.repositories, appEnv)
		// Only the lease holder may cancel external work, and only while it still holds the lease.
		invocation.lease.assertHeld()
		const result = await deps.provider.cancel({
			signal: invocation.lease.signal,
			runId: cancelling.id,
			externalId: cancelling.external_run_id,
			environment,
			startedAtMs: (cancelling.started_at ?? cancelling.created_at) * 1000,
			...(returnOrigins === undefined ? {} : { returnOrigins }),
			...(cancelling.provider_state_json === null
				? {}
				: { providerState: parseProviderJson(cancelling.provider_state_json, `provider state for run ${cancelling.id}`) }),
		})
		if (result.state === 'pending') return null
		outcome = result.outcome ?? 'failed'
		if (outcome === 'succeeded') activated = appEnv
	}
	await invocation.write((fence) => deps.repositories.runs.markRunCancellationFinished(cancelling.id, outcome, fence))
	if (activated !== null) await retirePlatformKeys(deps, activated, cancelling.id)
	return outcome
}

export async function cancelDeploy(
	deps: Pick<RunDeps, 'repositories' | 'provider' | 'lock' | 'leaseClock' | 'platformTransport'>,
	run: RunRow,
): Promise<void> {
	const cancelling = await deps.repositories.runs.requestRunCancellation(run.id)
	if (cancelling === null) return
	// A live holder settles the request at its next step boundary.
	const invocation = await RunInvocation.acquire(deps, cancelling)
	if (invocation === null) return
	try {
		await settleRunCancellation(deps, invocation)
	} finally {
		await invocation.release()
	}
}
