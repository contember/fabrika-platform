import { ReconcileSchemaError } from '@fabrika/auth'
import type {
	ControlProvider,
	JsonValue,
	ProviderCodec,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderRegistration,
	ProviderRegistrationInput,
	ProviderSource,
	ProviderSourceBinding,
	ProviderSourceResolution,
	ProviderSourceResolutionInput,
	ProviderTerminalOutcome,
	SchemaReconciler,
} from '@fabrika/provider-contract'
import { abortableWait, decodeEnvelope, ProviderInvocationAbort } from '@fabrika/provider-contract'
import { isProxyHost } from '@fabrika/proxy-contract'
import { type RunnerIamReconcile, runnerIamReconcileSchema } from '@fabrika/runner-contract'
import { z } from 'zod'
import { cloudflareArtifactCodec } from './codec'
// `./runner` is this module: keep every import here clear of `oblaka-iac`, which the runner packages
// cannot typecheck (they do not relax the two strict flags the raw TS needs).
import { defaultReconcileSchema, parseAppSchema } from './schema'

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
	/** Every origin IAM may hand this app a session at, projected by the control plane (ADR-0022). */
	readonly returnOrigins?: readonly string[]
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
	returnOrigins: z.array(z.string().min(1)).optional(),
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

export interface CloudflareCloneSource {
	readonly repoUrl: string
}

/** A run's terminal outcome plus the IAM reconcile the executor compiled, if the plan reached that step. */
export type CloudflareRunOutcome = ProviderTerminalOutcome & { readonly iamReconcile?: RunnerIamReconcile; readonly dryRun?: boolean }

/** What the runner reports for a run after a control-plane restart: its persisted outcome, or still in flight. */
export type CloudflareRunRecovery = CloudflareRunOutcome | { readonly state: 'running' }

export interface CloudflareControlOptions {
	readonly accountId: string
	readonly apiToken: string
	readonly propustkaUrl?: string
	readonly propustkaProvisioningKey?: string
	readonly runnerKey: string
	/** Overridable for tests; production reconciles over HTTPS with the control plane's own admin key. */
	readonly reconcileSchema?: SchemaReconciler
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

const isLeaseLoss = (reason: unknown): boolean => reason instanceof ProviderInvocationAbort && reason.kind === 'lease_lost'

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

const buildJob = async (options: CloudflareControlOptions, input: ProviderDeployInput): Promise<CloudflareRunnerJob> => {
	input.signal.throwIfAborted()
	assertRegistrationApp(input)
	const storedTarget = decodeEnvelope('target', 'cloudflare', input.environment.target, cloudflareStoredTargetCodec)
	const artifact = decodeEnvelope('artifact', 'cloudflare', input.environment.artifact, cloudflareArtifactCodec)
	const ref = input.app.source.ref
	if (!input.dryRun && !isCanonicalCommit(ref)) {
		throw new Error('Cloudflare deploy requires a canonical 40-character commit SHA')
	}
	const source = await awaitWithSignal(input.signal, () => options.prepareClone(input.app.source, input.signal, input.sourceBinding))
	const managedEnvironment: Record<string, string> = {}
	for (const [name, value] of Object.entries(input.managedEnvironment)) {
		if (value !== null) managedEnvironment[name] = value
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
		...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
		...(input.dryRun ? { dryRun: true } : {}),
		...(Object.keys(input.secrets).length === 0 ? {} : { secrets: input.secrets }),
		...(Object.keys(input.vars).length === 0 ? {} : { vars: input.vars }),
		...(Object.keys(managedEnvironment).length === 0 ? {} : { managedEnvironment }),
		...(input.artifactUpload === undefined ? {} : { artifactUpload: input.artifactUpload }),
	}
}

/** A megabyte of vocabulary is already absurd; beyond it the control plane refuses to parse at all. */
const MAX_SCHEMA_JSON_CHARS = 1024 * 1024

/** The app a terminal outcome belongs to, and where IAM may hand it a session. */
interface IamReconcileTarget {
	readonly appId: string
	readonly returnOrigins?: readonly string[]
	readonly signal: AbortSignal
}

/** The executor's report itself is unusable; retrying cannot make it valid. */
class InvalidIamReport extends Error {}

/**
 * Apply the schema the executor compiled, with the control plane's own IAM key. The control port may
 * have implementations other than the runner relay, so validate and bound its report before IAM hears it.
 */
const applyIamReconcile = async (
	options: CloudflareControlOptions,
	target: IamReconcileTarget,
	report: RunnerIamReconcile,
): Promise<void> => {
	const parsedReport = runnerIamReconcileSchema.safeParse(report)
	if (!parsedReport.success) {
		throw new InvalidIamReport('reported an authz schema whose app id or body is not a string')
	}
	const reconcile = parsedReport.data
	if (reconcile.app !== target.appId) {
		throw new InvalidIamReport(`reported an authz schema for app "${reconcile.app}", expected "${target.appId}"`)
	}
	if (reconcile.schemaJson.length > MAX_SCHEMA_JSON_CHARS) {
		throw new InvalidIamReport(`reported an authz schema of ${reconcile.schemaJson.length} characters, over the ${MAX_SCHEMA_JSON_CHARS} limit`)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(reconcile.schemaJson)
	} catch {
		throw new InvalidIamReport('reported an authz schema that is not valid JSON')
	}
	const schema = parseAppSchema(parsed)
	if (!schema.ok) {
		throw new InvalidIamReport(`reported a malformed authz schema: ${schema.message}`)
	}
	if (options.propustkaUrl === undefined) return
	// Return origins ride this call because `apps.setReturnOrigins` 404s for an app IAM has never heard
	// of, and the schema reconcile is what registers it. Separate call, same moment.
	const returnOrigins = target.returnOrigins !== undefined && target.returnOrigins.length > 0 ? target.returnOrigins : undefined
	await (options.reconcileSchema ?? defaultReconcileSchema)({
		url: options.propustkaUrl,
		app: target.appId,
		schema: schema.schema,
		...(returnOrigins === undefined ? {} : { returnOrigins }),
		...(options.propustkaProvisioningKey === undefined ? {} : { adminKey: options.propustkaProvisioningKey }),
		signal: target.signal,
	})
}

/**
 * Settle a terminal outcome: apply its IAM reconcile, if any, before Control marks the run terminal. Both
 * the awaited deploy and a post-restart reconcile come through here under Control's lease. IAM replaces
 * the app's whole vocabulary, so applying the same schema again after a lost lease is harmless.
 * `retryUnavailableIam` keeps the run in flight when IAM was unreachable or answered 5xx/408/429, so the
 * next reconcile retries; an invalid report or any other IAM refusal fails the run.
 */
const settleOutcome = async (
	options: CloudflareControlOptions,
	target: IamReconcileTarget,
	outcome: CloudflareRunOutcome,
	log: (line: string) => Promise<void>,
	retryUnavailableIam: boolean,
): Promise<ProviderTerminalOutcome | { readonly state: 'running' }> => {
	const failed: ProviderTerminalOutcome = { state: 'failed', ...(outcome.artifactState === undefined ? {} : { artifactState: outcome.artifactState }) }
	const reconcile = outcome.iamReconcile
	if (reconcile === undefined) return outcome
	if (outcome.dryRun === true) {
		await log('reconcile-schema refused: a dry run reported an authz schema')
		return failed
	}
	try {
		await applyIamReconcile(options, target, reconcile)
	} catch (error) {
		target.signal.throwIfAborted()
		await log(`reconcile-schema failed: ${error instanceof Error ? error.message : 'unknown error'}`)
		if (retryUnavailableIam && isTransientIamFailure(error)) return { state: 'running' }
		return failed
	}
	return outcome
}

const isTransientIamFailure = (error: unknown): boolean => {
	if (error instanceof InvalidIamReport) return false
	if (!(error instanceof ReconcileSchemaError)) return true
	return error.status >= 500 || error.status === 408 || error.status === 429
}

/** Build the Cloudflare control capability over its runner and source-resolution ports. */
export const createCloudflareControlProvider = (options: CloudflareControlOptions): ControlProvider => ({
	id: 'cloudflare',
	normalizeRegistration,
	source: { binding: 'installation' },
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
		const target = { appId: input.app.id, signal: input.signal, ...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }) }
		const log = async (line: string): Promise<void> => input.events.log(line)
		return settleOutcome(options, target, outcome, log, false)
	},
	reconcile: async (input) => {
		input.signal.throwIfAborted()
		const recoverRun = options.recoverRun
		if (recoverRun === undefined) return { state: 'running' }
		const recovery = await awaitWithSignal(input.signal, () => recoverRun(input.runId))
		if (recovery.state === 'running') return { state: 'running' }
		const target = {
			appId: input.environment.appId,
			signal: input.signal,
			...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
		}
		const log = async (line: string): Promise<void> => {
			if (input.log === undefined) console.error(`run ${input.runId}: ${line}`)
			else await input.log(line)
		}
		const outcome = await settleOutcome(options, target, recovery, log, true)
		if (outcome.state === 'running') return outcome
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
