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
	readonly dryRun?: boolean
	readonly credentials: {
		readonly CLOUDFLARE_ACCOUNT_ID: string
		readonly CLOUDFLARE_API_TOKEN: string
		readonly PROPUSTKA_URL?: string
		readonly PROPUSTKA_PROVISIONING_KEY?: string
	}
	readonly secrets?: Readonly<Record<string, string>>
	readonly vars?: Readonly<Record<string, string>>
}

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
	return (
		'CLOUDFLARE_ACCOUNT_ID' in credentials
		&& typeof credentials.CLOUDFLARE_ACCOUNT_ID === 'string'
		&& credentials.CLOUDFLARE_ACCOUNT_ID !== ''
		&& 'CLOUDFLARE_API_TOKEN' in credentials
		&& typeof credentials.CLOUDFLARE_API_TOKEN === 'string'
		&& credentials.CLOUDFLARE_API_TOKEN !== ''
	)
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
	return {
		runId: input.runId,
		repoUrl: source.repoUrl,
		ref: source.ref,
		env: input.environment.env,
		credentials: {
			CLOUDFLARE_ACCOUNT_ID: options.accountId,
			CLOUDFLARE_API_TOKEN: options.apiToken,
			...(options.propustkaUrl === undefined ? {} : { PROPUSTKA_URL: options.propustkaUrl }),
			...(options.propustkaProvisioningKey === undefined
				? {}
				: { PROPUSTKA_PROVISIONING_KEY: options.propustkaProvisioningKey }),
		},
		...(input.app.source.workerDir === undefined ? {} : { workerDir: input.app.source.workerDir }),
		configPath: artifact.configPath,
		...(storedTarget.stateNamespace === undefined ? {} : { stateNamespace: storedTarget.stateNamespace }),
		...(input.environment.domain === undefined ? {} : { domain: input.environment.domain }),
		...(input.dryRun ? { dryRun: true } : {}),
		...(Object.keys(input.secrets).length === 0 ? {} : { secrets: input.secrets }),
		...(Object.keys(input.vars).length === 0 ? {} : { vars: input.vars }),
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
