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
} from '@fabrika/provider-contract'
import { cloudflareArtifactCodec } from './codec'

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
	readonly credentials: {
		readonly CLOUDFLARE_ACCOUNT_ID: string
		readonly CLOUDFLARE_API_TOKEN: string
		readonly FABRIKA_IAM_URL?: string
		readonly FABRIKA_IAM_PROVISIONING_KEY?: string
		/** @deprecated Accepted only for queued jobs created before ADR-0018. */
		readonly PROPUSTKA_URL?: string
		/** @deprecated Accepted only for queued jobs created before ADR-0018. */
		readonly PROPUSTKA_PROVISIONING_KEY?: string
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

/** Minimal structural validation for the Worker-to-runner JSON boundary. */
export const isCloudflareRunnerJob = (value: unknown): value is CloudflareRunnerJob => {
	if (
		typeof value !== 'object'
		|| value === null
		|| !('runId' in value && typeof value.runId === 'string')
		|| !('repoUrl' in value && typeof value.repoUrl === 'string')
		|| !('ref' in value && typeof value.ref === 'string')
		|| !('env' in value && typeof value.env === 'string')
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
	if (!requiredCredentials) {
		return false
	}
	if (
		('FABRIKA_IAM_URL' in credentials && credentials.FABRIKA_IAM_URL !== undefined && typeof credentials.FABRIKA_IAM_URL !== 'string')
		|| ('FABRIKA_IAM_PROVISIONING_KEY' in credentials
			&& credentials.FABRIKA_IAM_PROVISIONING_KEY !== undefined
			&& typeof credentials.FABRIKA_IAM_PROVISIONING_KEY !== 'string')
		|| ('PROPUSTKA_URL' in credentials && credentials.PROPUSTKA_URL !== undefined && typeof credentials.PROPUSTKA_URL !== 'string')
		|| ('PROPUSTKA_PROVISIONING_KEY' in credentials
			&& credentials.PROPUSTKA_PROVISIONING_KEY !== undefined
			&& typeof credentials.PROPUSTKA_PROVISIONING_KEY !== 'string')
		|| ('workerDir' in value && value.workerDir !== undefined && typeof value.workerDir !== 'string')
		|| ('configPath' in value && value.configPath !== undefined && typeof value.configPath !== 'string')
		|| ('stateNamespace' in value && value.stateNamespace !== undefined && typeof value.stateNamespace !== 'string')
		|| ('domain' in value && value.domain !== undefined && typeof value.domain !== 'string')
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

export interface CloudflareControlOptions {
	readonly accountId: string
	readonly apiToken: string
	readonly propustkaUrl?: string
	readonly propustkaProvisioningKey?: string
	resolveSource(source: ProviderSource): Promise<ResolvedCloudflareSource>
	startRun(job: CloudflareRunnerJob): Promise<ProviderTerminalOutcome>
	cancelRun(runId: string): Promise<void>
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
	const source = await options.resolveSource(input.app.source)
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
		credentials: {
			CLOUDFLARE_ACCOUNT_ID: options.accountId,
			CLOUDFLARE_API_TOKEN: options.apiToken,
			...(options.propustkaUrl === undefined ? {} : { FABRIKA_IAM_URL: options.propustkaUrl }),
			...(options.propustkaProvisioningKey === undefined
				? {}
				: { FABRIKA_IAM_PROVISIONING_KEY: options.propustkaProvisioningKey }),
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

/** Build the Cloudflare control capability over its runner and source-resolution ports. */
export const createCloudflareControlProvider = (options: CloudflareControlOptions): ControlProvider => ({
	id: 'cloudflare',
	normalizeRegistration,
	deploy: async (input) => {
		await input.events.externalId(input.runId)
		return options.startRun(await buildJob(options, input))
	},
	cancel: (input) => options.cancelRun(input.runId),
})
