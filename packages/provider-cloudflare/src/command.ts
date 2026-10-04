import { deploy } from '@fabrika/engine'
import type { ProviderDeployResult, ProviderRunEvents, RuntimeProviderRun } from '@fabrika/provider-contract'
import type { CloudflareAppConfig } from './authoring'
import { cloudflareArtifact } from './codec'
import { defaultCloudflareCollaborators, loadCloudflareConfig } from './collaborators'
import { createCloudflareProvider } from './provider'

const requiredEnvironmentValue = (name: string): string => {
	const value = environmentValue(name)
	if (value === undefined || value === '') {
		throw new Error(`Missing ${name} environment variable`)
	}
	return value
}

const declaredValues = (names: readonly string[] | undefined): Record<string, string> => {
	const values: Record<string, string> = {}
	for (const name of names ?? []) {
		const value = environmentValue(name)
		if (value !== undefined && value !== '') {
			values[name] = value
		}
	}
	return values
}

const environmentValue = (name: string): string | undefined => process.env[name]

const requiredValues = (names: readonly string[] | undefined): Record<string, string> => {
	const values: Record<string, string> = {}
	for (const name of names ?? []) {
		values[name] = requiredEnvironmentValue(name)
	}
	return values
}

/**
 * Decode `FABRIKA_IAM_RETURN_ORIGINS`, the comma-separated set the control plane projects into the
 * deploy environment (ADR-0021). Undefined for an absent or empty value, so a deploy with nothing to
 * project leaves IAM's registry alone rather than clearing it. Part of the executor's environment
 * contract, exported for the test that pins it; not part of the package's public surface.
 */
export const parseReturnOrigins = (raw: string | undefined): readonly string[] | undefined => {
	const origins = (raw ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
	return origins.length === 0 ? undefined : origins
}

export interface LoadedCloudflareCommandConfig {
	readonly config: CloudflareAppConfig
	readonly absolutePath: string
	readonly cwd: string
}

export const loadCloudflareCommandConfig = async (configPath: string, cwd: string): Promise<LoadedCloudflareCommandConfig> =>
	loadCloudflareConfig(cwd, configPath)

export interface CloudflareCommandDeployOptions {
	readonly env: string
	readonly configPath?: string
	readonly cwd?: string
	readonly dryRun?: boolean
	readonly stateNamespace?: string
	readonly managedVarNames?: readonly string[]
	/** Defaults to `refuse`: only fabrika deploying its own components may name a platform resource. */
	readonly platformResources?: 'refuse' | 'allow'
	readonly signal?: AbortSignal
	readonly log?: (line: string) => void
}

/** Build an opaque provider run from one config and execute it through the neutral engine. */
export const deployCloudflareConfig = async (options: CloudflareCommandDeployOptions): Promise<ProviderDeployResult> => {
	const cwd = options.cwd ?? process.cwd()
	const loaded = await loadCloudflareCommandConfig(options.configPath ?? './fabrika.config.ts', cwd)
	const events: ProviderRunEvents = {
		log: options.log ?? ((line) => console.log(line)),
		externalId: async () => {},
		checkpoint: async () => {},
	}
	const provider = createCloudflareProvider(defaultCloudflareCollaborators, {
		platformResources: options.platformResources ?? 'refuse',
	})
	const domain = environmentValue('FABRIKA_CONTROL_DOMAIN')
	const returnOrigins = parseReturnOrigins(environmentValue('FABRIKA_IAM_RETURN_ORIGINS'))
	const run: RuntimeProviderRun = {
		appId: loaded.config.id,
		env: options.env,
		...(domain === undefined ? {} : { domain }),
		...(returnOrigins === undefined ? {} : { returnOrigins }),
		cwd: loaded.cwd,
		secrets: declaredValues(loaded.config.pipeline?.secrets),
		vars: declaredValues(loaded.config.pipeline?.vars),
		managedEnvironment: requiredValues(options.managedVarNames),
		dryRun: options.dryRun ?? false,
		signal: options.signal ?? new AbortController().signal,
		events,
		target: provider.encodeTarget({
			accountId: requiredEnvironmentValue('CLOUDFLARE_ACCOUNT_ID'),
			apiToken: requiredEnvironmentValue('CLOUDFLARE_API_TOKEN'),
			...(options.stateNamespace === undefined ? {} : { stateNamespace: options.stateNamespace }),
		}),
		artifact: provider.encodeArtifact(cloudflareArtifact(loaded.absolutePath)),
	}
	return deploy(provider.runtime, run)
}
