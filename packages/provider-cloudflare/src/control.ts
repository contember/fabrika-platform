import type {
	ControlProvider,
	JsonValue,
	ProviderCodec,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderRegistration,
	ProviderRegistrationInput,
	ProviderSource,
	ProviderTerminalOutcome,
	SchemaReconciler,
} from '@fabrika/provider-contract'
import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import { isProxyHost } from '@fabrika/proxy-contract'
import type { RunnerIamReconcile } from '@fabrika/runner-contract'
import { cloudflareArtifactCodec } from './codec'
// `./runner` is this module: keep every import here clear of `oblaka-iac`, which the runner packages
// cannot typecheck (they do not relax the two strict flags the raw TS needs).
import { defaultReconcileSchema, parseAppSchema } from './schema'

/** Persisted Cloudflare target data. Installation credentials never enter this envelope. */
export interface CloudflareStoredTarget {
	readonly stateNamespace?: string
}

const optionalString = (payload: ProviderEnvelope['payload'], key: string): string | undefined => {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('Cloudflare target must be an object')
	}
	const value = payload[key]
	if (value === undefined) {
		return undefined
	}
	if (typeof value !== 'string' || value === '') {
		throw new Error(`Cloudflare target ${key} must be a non-empty string when present`)
	}
	return value
}

export const cloudflareStoredTargetCodec: ProviderCodec<CloudflareStoredTarget> = {
	version: 1,
	encode: (target): JsonValue => {
		if (target.stateNamespace === undefined) {
			return {}
		}
		return { stateNamespace: target.stateNamespace }
	},
	decode: (payload) => {
		const stateNamespace = optionalString(payload, 'stateNamespace')
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
	/** Every origin IAM may hand this app a session at, projected by the control plane (ADR-0021). */
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

const isStringArray = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '')

const isStringRecord = (value: unknown): boolean =>
	typeof value === 'object'
	&& value !== null
	&& !Array.isArray(value)
	&& Object.values(value).every((entry) => typeof entry === 'string')

const isArtifactUpload = (value: unknown): boolean =>
	typeof value === 'object'
	&& value !== null
	&& !Array.isArray(value)
	&& ['url', 'bearer', 'appId', 'environment', 'serviceKey', 'release', 'runId'].every((key) => {
		const field = Reflect.get(value, key)
		return typeof field === 'string' && field !== ''
	})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENV_NAME = /^[a-z0-9-]+$/

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

/**
 * Validate the Worker-to-runner JSON boundary by VALUE, not only by type: every field here becomes an
 * argv element, a filesystem path or a hostname inside the deploy container.
 */
export const isCloudflareRunnerJob = (value: unknown): value is CloudflareRunnerJob => {
	if (
		typeof value !== 'object'
		|| value === null
		|| !('runId' in value && typeof value.runId === 'string' && UUID.test(value.runId))
		|| !('repoUrl' in value && typeof value.repoUrl === 'string' && !hasUnsafeChars(value.repoUrl) && isHttpsUrl(value.repoUrl))
		|| !('ref' in value && typeof value.ref === 'string' && value.ref !== '' && !value.ref.startsWith('-') && !hasUnsafeChars(value.ref))
		|| !('env' in value && typeof value.env === 'string' && ENV_NAME.test(value.env))
		|| !('credentials' in value && typeof value.credentials === 'object' && value.credentials !== null)
	) {
		return false
	}
	const credentials = value.credentials
	const requiredCredentials = 'CLOUDFLARE_ACCOUNT_ID' in credentials
		&& typeof credentials.CLOUDFLARE_ACCOUNT_ID === 'string'
		&& credentials.CLOUDFLARE_ACCOUNT_ID !== ''
		&& 'CLOUDFLARE_API_TOKEN' in credentials
		&& typeof credentials.CLOUDFLARE_API_TOKEN === 'string'
		&& credentials.CLOUDFLARE_API_TOKEN !== ''
	// Exactly these two: a job carrying any other credential is refused rather than forwarded into the
	// child environment, which is where the container's own code would read it.
	if (!requiredCredentials || Object.keys(credentials).length !== 2) {
		return false
	}
	if (
		// OPTIONAL: the runner Worker strips the key before the container hop, so a job that reaches the
		// container carries none. Present means it must be usable; the Worker is what REQUIRES it.
		('runnerKey' in value && value.runnerKey !== undefined && (typeof value.runnerKey !== 'string' || value.runnerKey === ''))
		|| ('workerDir' in value && value.workerDir !== undefined && (typeof value.workerDir !== 'string' || !isContainedPath(value.workerDir)))
		|| ('configPath' in value && value.configPath !== undefined && (typeof value.configPath !== 'string' || !isContainedPath(value.configPath)))
		|| ('stateNamespace' in value && value.stateNamespace !== undefined && (typeof value.stateNamespace !== 'string' || value.stateNamespace === ''))
		|| ('domain' in value && value.domain !== undefined && (typeof value.domain !== 'string' || !isProxyHost(value.domain.toLowerCase())))
		|| ('returnOrigins' in value && value.returnOrigins !== undefined && !isStringArray(value.returnOrigins))
		|| ('dryRun' in value && value.dryRun !== undefined && typeof value.dryRun !== 'boolean')
		|| ('secrets' in value && value.secrets !== undefined && !isStringRecord(value.secrets))
		|| ('vars' in value && value.vars !== undefined && !isStringRecord(value.vars))
		|| ('managedEnvironment' in value && value.managedEnvironment !== undefined && !isStringRecord(value.managedEnvironment))
		|| ('artifactUpload' in value && value.artifactUpload !== undefined && !isArtifactUpload(value.artifactUpload))
	) {
		return false
	}
	return true
}

export interface ResolvedCloudflareSource {
	readonly repoUrl: string
	readonly ref: string
}

/** A run's terminal outcome plus the IAM reconcile the executor compiled, if the plan reached that step. */
export type CloudflareRunOutcome = ProviderTerminalOutcome & { readonly iamReconcile?: RunnerIamReconcile }

export interface CloudflareControlOptions {
	readonly accountId: string
	readonly apiToken: string
	readonly propustkaUrl?: string
	readonly propustkaProvisioningKey?: string
	readonly runnerKey: string
	/** Overridable for tests; production reconciles over HTTPS with the control plane's own admin key. */
	readonly reconcileSchema?: SchemaReconciler
	resolveSource(source: ProviderSource, signal: AbortSignal): Promise<ResolvedCloudflareSource>
	startRun(job: CloudflareRunnerJob): Promise<CloudflareRunOutcome>
	cancelRun(runId: string): Promise<void>
	recoverRun?(runId: string): Promise<'running' | 'failed'>
}

const decodeEnvelope = <T>(kind: string, envelope: ProviderEnvelope, codec: ProviderCodec<T>): T => {
	if (envelope.provider !== 'cloudflare') {
		throw new Error(`${kind} belongs to provider "${envelope.provider}", expected "cloudflare"`)
	}
	if (envelope.version !== codec.version) {
		throw new Error(`${kind} schema version ${envelope.version} is not supported by provider "cloudflare"`)
	}
	return codec.decode(envelope.payload)
}

const encodeEnvelope = <T>(codec: ProviderCodec<T>, value: T): ProviderEnvelope => ({
	provider: 'cloudflare',
	version: codec.version,
	payload: codec.encode(value),
})

const normalizeRegistration = (input: ProviderRegistrationInput): ProviderRegistration => {
	if (input.app.id !== input.environment.appId) {
		throw new Error(`Cloudflare environment belongs to app "${input.environment.appId}", expected "${input.app.id}"`)
	}
	const target = decodeEnvelope('target', input.environment.target, cloudflareStoredTargetCodec)
	const artifact = decodeEnvelope('artifact', input.environment.artifact, cloudflareArtifactCodec)
	return {
		app: input.app,
		environment: {
			...input.environment,
			target: encodeEnvelope(cloudflareStoredTargetCodec, target),
			artifact: encodeEnvelope(cloudflareArtifactCodec, artifact),
		},
	}
}

const buildJob = async (options: CloudflareControlOptions, input: ProviderDeployInput): Promise<CloudflareRunnerJob> => {
	const source = await options.resolveSource(input.app.source, input.signal)
	const storedTarget = decodeEnvelope('target', input.environment.target, cloudflareStoredTargetCodec)
	const artifact = decodeEnvelope('artifact', input.environment.artifact, cloudflareArtifactCodec)
	const managedEnvironment: Record<string, string> = {}
	for (const [name, value] of Object.entries(input.managedEnvironment)) {
		if (value !== null) managedEnvironment[name] = value
	}
	return {
		runId: input.runId,
		repoUrl: source.repoUrl,
		ref: source.ref,
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

/**
 * Apply the schema the executor compiled, with the control plane's own IAM key. The container runs the
 * checkout's code and nothing validates its `/status` body on the way, so every field of the report is
 * type-checked, bounded and parsed here before IAM hears about it.
 */
const applyIamReconcile = async (
	options: CloudflareControlOptions,
	input: ProviderDeployInput,
	reconcile: RunnerIamReconcile,
): Promise<void> => {
	// Typed, but not validated by any transport between the container and here.
	if (typeof reconcile.app !== 'string' || typeof reconcile.schemaJson !== 'string') {
		throw new Error('reported an authz schema whose app id or body is not a string')
	}
	if (reconcile.app !== input.app.id) {
		throw new Error(`reported an authz schema for app "${reconcile.app}", expected "${input.app.id}"`)
	}
	if (reconcile.schemaJson.length > MAX_SCHEMA_JSON_CHARS) {
		throw new Error(`reported an authz schema of ${reconcile.schemaJson.length} characters, over the ${MAX_SCHEMA_JSON_CHARS} limit`)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(reconcile.schemaJson)
	} catch {
		throw new Error('reported an authz schema that is not valid JSON')
	}
	const schema = parseAppSchema(parsed)
	if (!schema.ok) {
		throw new Error(`reported a malformed authz schema: ${schema.message}`)
	}
	if (options.propustkaUrl === undefined) return
	// Return origins ride this call because `apps.setReturnOrigins` 404s for an app IAM has never heard
	// of, and the schema reconcile is what registers it. Separate call, same moment.
	const returnOrigins = input.returnOrigins !== undefined && input.returnOrigins.length > 0 ? input.returnOrigins : undefined
	await (options.reconcileSchema ?? defaultReconcileSchema)({
		url: options.propustkaUrl,
		app: input.app.id,
		schema: schema.schema,
		...(returnOrigins === undefined ? {} : { returnOrigins }),
		...(options.propustkaProvisioningKey === undefined ? {} : { adminKey: options.propustkaProvisioningKey }),
		signal: input.signal,
	})
}

/** Build the Cloudflare control capability over its runner and source-resolution ports. */
export const createCloudflareControlProvider = (options: CloudflareControlOptions): ControlProvider => ({
	id: 'cloudflare',
	normalizeRegistration,
	deploy: async (input) => {
		const job = await buildJob(options, input)
		input.signal.throwIfAborted()
		await input.events.externalId(input.runId)
		input.signal.throwIfAborted()
		const interrupted = Promise.withResolvers<never>()
		const abort = (): void => {
			const reason: unknown = input.signal.reason
			if (reason instanceof ProviderInvocationAbort && reason.kind === 'cancel_requested') {
				void options.cancelRun(input.runId).catch(() => {})
			}
			interrupted.reject(reason)
		}
		input.signal.addEventListener('abort', abort, { once: true })
		let outcome: CloudflareRunOutcome
		try {
			outcome = await Promise.race([options.startRun(job), interrupted.promise])
		} finally {
			input.signal.removeEventListener('abort', abort)
		}
		input.signal.throwIfAborted()
		const reconcile = outcome.iamReconcile
		if (reconcile === undefined || input.dryRun) return outcome
		try {
			await applyIamReconcile(options, input, reconcile)
		} catch (error) {
			input.signal.throwIfAborted()
			input.events.log(`reconcile-schema failed: ${error instanceof Error ? error.message : 'unknown error'}`)
			return { state: 'failed', ...(outcome.artifactState === undefined ? {} : { artifactState: outcome.artifactState }) }
		}
		return outcome
	},
	reconcile: async (input) => {
		input.signal.throwIfAborted()
		if (options.recoverRun === undefined) return { state: 'running' }
		const state = await options.recoverRun(input.runId)
		input.signal.throwIfAborted()
		return { state }
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
