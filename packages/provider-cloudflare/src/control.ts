import { type AppEnvironment, appEnvironmentId, FABRIKA_PROXY_SECRET, parseAppEnvironmentId } from '@fabrika/auth-core'
import type {
	ControlProvider,
	JsonValue,
	ProviderApprovedAccess,
	ProviderCodec,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderEnvironment,
	ProviderRegistration,
	ProviderRegistrationInput,
	ProviderSource,
	ProviderSourceBinding,
	ProviderSourceResolution,
	ProviderSourceResolutionInput,
	ProviderTerminalOutcome,
} from '@fabrika/provider-contract'
import { abortableWait, decodeEnvelope, isLeaseLoss, ProviderInvocationAbort } from '@fabrika/provider-contract'
import { isCrossOrigin, isPolicyOrigin, MAX_CROSS_ORIGINS } from '@fabrika/proxy-core/headers'
import { isProxyHost } from '@fabrika/proxy-core/manifest'
import { z } from 'zod'
import { cloudflareArtifactCodec } from './codec'
import { assertCloudflareContract, assertStatelessEnvironment, runsInObject, servesOps } from './contract-support'
// `./runner` is this module: keep every import here clear of `oblaka-iac`, which the runner packages
// cannot typecheck (they do not relax the two strict flags the raw TS needs).
import { type RunnerApprovedAccess, runnerApprovedAccessSchema, type RunnerIamReconcile } from './runner-protocol'

export * from './runner-protocol'

/** Persisted Cloudflare target data. Installation credentials never enter this envelope. */
export interface CloudflareStoredTarget {
	readonly stateNamespace?: string
}

const storedTargetSchema = z.object({ stateNamespace: z.string().min(1).optional() })

export const cloudflareStoredTargetCodec: ProviderCodec<CloudflareStoredTarget> = {
	version: 1,
	encode: (target): JsonValue => {
		if (target.stateNamespace === undefined) {
			return {}
		}
		return { stateNamespace: target.stateNamespace }
	},
	decode: (payload) => {
		const { stateNamespace } = storedTargetSchema.parse(payload)
		return stateNamespace === undefined ? {} : { stateNamespace }
	},
}

/** Cloudflare-specific request carried from the control plane to the deploy runner. */
export interface CloudflareRunnerJob {
	readonly runId: string
	readonly repoUrl: string
	readonly ref: string
	readonly env: string
	readonly workerDir?: string
	readonly configPath?: string
	readonly stateNamespace?: string
	readonly domain?: string
	/** The environment's cross-origin list from Control's registry (ADR-0022); the proxy Worker's manifest entry lists it. */
	readonly crossOrigins?: readonly string[]
	/** The origin of the environment's Operations ingest, from Control; the proxy Worker's `connect-src` admits it. */
	readonly operationsOrigin?: string
	/** `<app>@<env>` of every Cloudflare deployment in Control's registry; the deploy refuses another application's names. */
	readonly installationApps?: readonly string[]
	/** What the deployed proxy enforces and the application starts as; every run but a dry one carries it. */
	readonly approvedAccess?: RunnerApprovedAccess
	readonly dryRun?: boolean
	/**
	 * Shared secret the runner verifies before it touches D1 or the container; the binding alone proves
	 * nothing. Optional in the type because the wire boundary may omit it — the Worker refuses it there.
	 */
	readonly runnerKey?: string
	/** Exactly the Cloudflare account credential. IAM's admin key stays in the control plane (ADR-0022). */
	readonly credentials: {
		readonly CLOUDFLARE_ACCOUNT_ID: string
		readonly CLOUDFLARE_API_TOKEN: string
	}
	readonly secrets?: Readonly<Record<string, string>>
	readonly vars?: Readonly<Record<string, string>>
	readonly managedEnvironment?: Readonly<Record<string, string>>
	readonly artifactUpload?: {
		readonly url: string
		readonly bearer: string
		readonly appId: string
		readonly environment: string
		readonly serviceKey: string
		readonly release: string
		readonly runId: string
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENV_NAME = /^[a-z0-9-]+$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const isCanonicalCommit = (value: string): boolean => value.length === 40 && COMMIT_SHA.test(value)

/** Whitespace or a control character in a value that becomes an argv element or a filesystem path. */
const hasUnsafeChars = (value: string): boolean =>
	/\s/.test(value) || [...value].some((char) => {
		const code = char.codePointAt(0) ?? 0
		return code < 0x20 || code === 0x7f
	})

const isHttpsUrl = (value: string): boolean => {
	try {
		return new URL(value).protocol === 'https:'
	} catch {
		return false
	}
}

/**
 * The checkout-relative directory a relative `path` names, as the runner resolves it: `''` for the checkout itself
 * (`.`, `./` and no path), empty and `.` segments dropped, or null for an absolute path or one with a `..` segment.
 * The runner executes from this directory and Control reads the run's snapshot there, so both normalize with this.
 */
export const checkoutRelativeDirectory = (path: string | undefined): string | null => {
	if (path === undefined) return ''
	if (path.startsWith('/')) return null
	const segments = path.split('/')
	if (segments.includes('..')) return null
	return segments.filter((segment) => segment !== '' && segment !== '.').join('/')
}

/** A path that stays inside the checkout: relative, and with no `..` segment to climb out of it. */
const isContainedPath = (value: string): boolean =>
	value !== '' && !value.startsWith('/') && !hasUnsafeChars(value) && !value.split('/').includes('..')

// Entries preserve own environment names such as `__proto__`, which Zod's record parser drops.
const stringRecordSchema = z.preprocess(
	(value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : undefined,
	z.array(z.tuple([z.string(), z.string()])).transform((entries) => Object.fromEntries(entries)),
)

/**
 * Validate the Worker-to-runner JSON boundary by VALUE, not only by type: every field here becomes an
 * argv element, a filesystem path or a hostname inside the deploy container.
 */
export const cloudflareRunnerJobSchema = z.object({
	runId: z.string().regex(UUID),
	repoUrl: z.string().refine((value) => !hasUnsafeChars(value) && isHttpsUrl(value)),
	ref: z.string().min(1).refine((value) => !value.startsWith('-') && !hasUnsafeChars(value)),
	env: z.string().regex(ENV_NAME),
	credentials: z.object({ CLOUDFLARE_ACCOUNT_ID: z.string().min(1), CLOUDFLARE_API_TOKEN: z.string().min(1) }).strict(),
	runnerKey: z.string().min(1).optional(),
	workerDir: z.string().refine(isContainedPath).optional(),
	configPath: z.string().refine(isContainedPath).optional(),
	stateNamespace: z.string().min(1).optional(),
	domain: z.string().refine((value) => isProxyHost(value.toLowerCase())).optional(),
	crossOrigins: z.array(z.string().refine(isCrossOrigin)).max(MAX_CROSS_ORIGINS).optional(),
	operationsOrigin: z.string().refine((origin) => isPolicyOrigin(origin, ['https:', 'http:'])).optional(),
	installationApps: z.array(z.string().refine((id) => !hasUnsafeChars(id) && parseAppEnvironmentId(id) !== null)).optional(),
	approvedAccess: runnerApprovedAccessSchema.optional(),
	dryRun: z.boolean().optional(),
	secrets: stringRecordSchema.optional(),
	vars: stringRecordSchema.optional(),
	managedEnvironment: stringRecordSchema.optional(),
	artifactUpload: z.object({
		url: z.string().min(1),
		bearer: z.string().min(1),
		appId: z.string().min(1),
		environment: z.string().min(1),
		serviceKey: z.string().min(1),
		release: z.string().min(1),
		runId: z.string().min(1),
	}).optional(),
}).refine((job) => job.dryRun === true || isCanonicalCommit(job.ref))
	.refine((job) => crossOriginsFit(job.crossOrigins ?? [], job.domain))
	.refine((job) => job.dryRun === true || job.approvedAccess !== undefined)

/**
 * Each origin once, never the environment's own domain: the rule the proxy manifest parser applies to the entry. A
 * refinement also runs over an origin its element check refused, so the host is read only from a valid one.
 */
function crossOriginsFit(origins: readonly string[], domain: string | undefined): boolean {
	const host = domain?.toLowerCase()
	return new Set(origins).size === origins.length && origins.every((origin) => isCrossOrigin(origin) && new URL(origin).hostname !== host)
}

export interface CloudflareCloneSource {
	readonly repoUrl: string
}

/** A run's terminal outcome plus what the executor reported: the IAM schema it compiled. */
export type CloudflareRunOutcome = ProviderTerminalOutcome & {
	readonly iamReconcile?: RunnerIamReconcile
	readonly dryRun?: boolean
}

/** What the runner reports for a run after a control-plane restart: its persisted outcome, or still in flight. */
export type CloudflareRunRecovery = CloudflareRunOutcome | { readonly state: 'running' }

export interface CloudflareControlOptions {
	readonly accountId: string
	readonly apiToken: string
	readonly runnerKey: string
	/** Every Cloudflare deployment in Control's registry, sent with each job so another application's names are refused. */
	installationApps?(signal: AbortSignal): Promise<readonly AppEnvironment[]>
	resolveSource(input: ProviderSourceResolutionInput): Promise<ProviderSourceResolution>
	prepareClone(source: ProviderSource, signal: AbortSignal, sourceBinding?: ProviderSourceBinding): Promise<CloudflareCloneSource>
	startRun(job: CloudflareRunnerJob): Promise<CloudflareRunOutcome>
	cancelRun(runId: string): Promise<void>
	recoverRun?(runId: string): Promise<CloudflareRunRecovery>
	/** Overridable for tests; the wait between two reads of Control's step boundary. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const BOUNDARY_INTERVAL_MS = 10_000

/** Read Control's step boundary while the runner works; a rejection that matters aborts the run signal. */
const readBoundaries = async (events: ProviderDeployInput['events'], sleep: CloudflareControlOptions['sleep'], stop: AbortSignal): Promise<void> => {
	try {
		for (;;) {
			await (sleep ?? abortableWait)(BOUNDARY_INTERVAL_MS, stop)
			await events.boundary().catch(() => {})
		}
	} catch {
		// `stop` aborted: the runner answered.
	}
}

const encodeEnvelope = <T>(codec: ProviderCodec<T>, value: T): ProviderEnvelope => ({
	provider: 'cloudflare',
	version: codec.version,
	payload: codec.encode(value),
})

const assertRegistrationApp = (input: ProviderRegistrationInput): void => {
	if (input.app.id !== input.environment.appId) {
		throw new Error(`Cloudflare environment belongs to app "${input.environment.appId}", expected "${input.app.id}"`)
	}
}

const normalizeRegistration = (input: ProviderRegistrationInput): ProviderRegistration => {
	assertRegistrationApp(input)
	const target = decodeEnvelope('target', 'cloudflare', input.environment.target, cloudflareStoredTargetCodec)
	const artifact = decodeEnvelope('artifact', 'cloudflare', input.environment.artifact, cloudflareArtifactCodec)
	return {
		app: input.app,
		environment: {
			...input.environment,
			target: encodeEnvelope(cloudflareStoredTargetCodec, target),
			artifact: encodeEnvelope(cloudflareArtifactCodec, artifact),
		},
	}
}

const awaitWithSignal = async <T>(signal: AbortSignal, invoke: () => Promise<T>): Promise<T> => {
	signal.throwIfAborted()
	const interrupted = Promise.withResolvers<never>()
	const abort = (): void => interrupted.reject(signal.reason)
	signal.addEventListener('abort', abort, { once: true })
	try {
		const result = await Promise.race([invoke(), interrupted.promise])
		signal.throwIfAborted()
		return result
	} catch (error) {
		signal.throwIfAborted()
		throw error
	} finally {
		signal.removeEventListener('abort', abort)
	}
}

const runnerApprovedAccess = (environment: ProviderEnvironment): RunnerApprovedAccess | undefined =>
	environment.access === undefined
		? undefined
		: {
			kind: 'contract',
			contract: environment.access.contract,
			contractDigest: environment.access.contractDigest,
			framework: environment.access.checker,
		}

const buildJob = async (options: CloudflareControlOptions, input: ProviderDeployInput): Promise<CloudflareRunnerJob> => {
	input.signal.throwIfAborted()
	if (input.environment.kind === 'dev') throw new Error('Cloudflare runs no dev environment (ADR-0049); a dev environment runs on Zerops only')
	assertRegistrationApp(input)
	const storedTarget = decodeEnvelope('target', 'cloudflare', input.environment.target, cloudflareStoredTargetCodec)
	const artifact = decodeEnvelope('artifact', 'cloudflare', input.environment.artifact, cloudflareArtifactCodec)
	const ref = input.app.source.ref
	if (!input.dryRun && !isCanonicalCommit(ref)) {
		throw new Error('Cloudflare deploy requires a canonical 40-character commit SHA')
	}
	const approvedAccess = runnerApprovedAccess(input.environment)
	// The deployer refuses it again from the contract it serves; this fails before the clone.
	if (approvedAccess !== undefined) assertCloudflareContract(approvedAccess.contract)
	const release = input.environment.access?.checker
	const stateless = release !== undefined && !runsInObject(release)
	if (stateless) assertStatelessEnvironment(input.managedEnvironment, release)
	const source = await awaitWithSignal(input.signal, () => options.prepareClone(input.app.source, input.signal, input.sourceBinding))
	const listInstallationApps = options.installationApps
	const installationApps = listInstallationApps === undefined
		? undefined
		: (await awaitWithSignal(input.signal, () => listInstallationApps(input.signal))).map((deployment) =>
			appEnvironmentId(deployment.app, deployment.env)
		)
	const managedEnvironment: Record<string, string> = {}
	for (const [name, { value }] of Object.entries(input.managedEnvironment)) {
		// An older release's Worker would demand the hop secret from a proxy Worker that never sends it.
		if (value !== null && !(stateless && name === FABRIKA_PROXY_SECRET)) managedEnvironment[name] = value
	}
	return {
		runId: input.runId,
		repoUrl: source.repoUrl,
		ref,
		env: input.environment.env,
		runnerKey: options.runnerKey,
		credentials: {
			CLOUDFLARE_ACCOUNT_ID: options.accountId,
			CLOUDFLARE_API_TOKEN: options.apiToken,
		},
		...(input.app.source.workerDir === undefined ? {} : { workerDir: input.app.source.workerDir }),
		configPath: artifact.configPath,
		...(storedTarget.stateNamespace === undefined ? {} : { stateNamespace: storedTarget.stateNamespace }),
		...(input.environment.domain === undefined ? {} : { domain: input.environment.domain }),
		...(input.environment.crossOrigins === undefined || input.environment.crossOrigins.length === 0
			? {}
			: { crossOrigins: input.environment.crossOrigins }),
		...(input.environment.operationsOrigin === undefined ? {} : { operationsOrigin: input.environment.operationsOrigin }),
		...(installationApps === undefined ? {} : { installationApps }),
		...(approvedAccess === undefined ? {} : { approvedAccess }),
		...(input.dryRun ? { dryRun: true } : {}),
		...(Object.keys(input.secrets).length === 0 ? {} : { secrets: input.secrets }),
		...(Object.keys(input.vars).length === 0 ? {} : { vars: input.vars }),
		...(Object.keys(managedEnvironment).length === 0 ? {} : { managedEnvironment }),
		...(input.artifactUpload === undefined ? {} : { artifactUpload: input.artifactUpload }),
	}
}

/**
 * Judge a terminal outcome's report before Control settles it. The runner may report the schema it compiled; Control
 * writes the approved one itself (ADR-0011), so a report is only evidence: a dry run that reports access, or a report
 * where Control approved none, fails the run.
 */
const settleOutcome = async (
	access: ProviderApprovedAccess | undefined,
	outcome: CloudflareRunOutcome,
	log: (line: string) => Promise<void>,
): Promise<ProviderTerminalOutcome> => {
	const terminal: ProviderTerminalOutcome = {
		state: outcome.state,
		...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
		...(outcome.artifactState === undefined ? {} : { artifactState: outcome.artifactState }),
	}
	if (outcome.iamReconcile === undefined) return terminal
	const failed: ProviderTerminalOutcome = { state: 'failed', ...(outcome.artifactState === undefined ? {} : { artifactState: outcome.artifactState }) }
	if (outcome.dryRun === true) {
		await log('reconcile-schema refused: a dry run reported access')
		return failed
	}
	if (access === undefined) {
		await log('reconcile-schema failed: reported access, but Control approved no access for this environment')
		return failed
	}
	return terminal
}

/** Build the Cloudflare control capability over its runner and source-resolution ports. */
export const createCloudflareControlProvider = (options: CloudflareControlOptions): ControlProvider => ({
	id: 'cloudflare',
	// The application's Worker forwards each request to its Durable Object with the environment's proxy secret.
	applicationHopSecret: true,
	// The environment's object serves Control's ops requests from the release that gets the composed row.
	opsChannel: (access) => servesOps(access.checker),
	normalizeRegistration,
	applicationRoot: (source) => checkoutRelativeDirectory(source.workerDir),
	source: { binding: 'connection' },
	resolveSource: async (input) => {
		input.signal.throwIfAborted()
		const registration = normalizeRegistration(input)
		return awaitWithSignal(input.signal, () => options.resolveSource({ ...input, ...registration }))
	},
	deploy: async (input) => {
		const job = await buildJob(options, input)
		await input.events.externalId(input.runId)
		input.signal.throwIfAborted()
		const interrupted = Promise.withResolvers<never>()
		const abort = (): void => {
			const reason: unknown = input.signal.reason
			if (reason instanceof ProviderInvocationAbort && reason.kind === 'cancel_requested') {
				// A boundary that finds the lease lost forbids the cancel (ADR-0044).
				void input.events.boundary().catch((error: unknown) => error).then((crossed) => isLeaseLoss(crossed) ? undefined : options.cancelRun(input.runId))
					.catch(() => {})
			}
			interrupted.reject(reason)
		}
		input.signal.addEventListener('abort', abort, { once: true })
		const stopBoundaries = new AbortController()
		const boundaries = readBoundaries(input.events, options.sleep, stopBoundaries.signal)
		let outcome: CloudflareRunOutcome
		try {
			outcome = await Promise.race([options.startRun(job), interrupted.promise])
		} catch (error) {
			input.signal.throwIfAborted()
			throw error
		} finally {
			input.signal.removeEventListener('abort', abort)
			stopBoundaries.abort()
			await boundaries
		}
		input.signal.throwIfAborted()
		if (input.dryRun) return outcome
		return settleOutcome(input.environment.access, outcome, async (line) => input.events.log(line))
	},
	reconcile: async (input) => {
		input.signal.throwIfAborted()
		const recoverRun = options.recoverRun
		if (recoverRun === undefined) return { state: 'running' }
		const recovery = await awaitWithSignal(input.signal, () => recoverRun(input.runId))
		if (recovery.state === 'running') return { state: 'running' }
		const log = async (line: string): Promise<void> => {
			if (input.log === undefined) console.error(`run ${input.runId}: ${line}`)
			else await input.log(line)
		}
		const outcome = await settleOutcome(input.environment.access, recovery, log)
		return {
			state: outcome.state,
			...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
			...(outcome.artifactState === undefined ? {} : { artifactState: outcome.artifactState }),
			...(recovery.dryRun === true ? { dryRun: true } : {}),
		}
	},
	cancel: async (input) => {
		input.signal.throwIfAborted()
		const interrupted = Promise.withResolvers<never>()
		const abort = (): void => interrupted.reject(input.signal.reason)
		input.signal.addEventListener('abort', abort, { once: true })
		try {
			await Promise.race([options.cancelRun(input.runId), interrupted.promise])
			input.signal.throwIfAborted()
			return { state: 'settled' }
		} finally {
			input.signal.removeEventListener('abort', abort)
		}
	},
})
