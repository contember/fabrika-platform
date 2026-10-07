import type { CloudflareAppConfig } from './authoring'
import { loadCloudflareConfig } from './collaborators'
import { type CloudflareDeployResult, createCloudflareDeployer } from './provider'

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
 * deploy environment (ADR-0022). Undefined for an absent or empty value, so a deploy with nothing to
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

/** Deploy one config with the account credentials, declared secrets and vars read from the environment. */
export const deployCloudflareConfig = async (options: CloudflareCommandDeployOptions): Promise<CloudflareDeployResult> => {
	const cwd = options.cwd ?? process.cwd()
	const loaded = await loadCloudflareCommandConfig(options.configPath ?? './fabrika.config.ts', cwd)
	const deploy = createCloudflareDeployer({
		accountId: requiredEnvironmentValue('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requiredEnvironmentValue('CLOUDFLARE_API_TOKEN'),
		platformResources: options.platformResources ?? 'refuse',
	})
	const domain = environmentValue('FABRIKA_CONTROL_DOMAIN')
	const returnOrigins = parseReturnOrigins(environmentValue('FABRIKA_IAM_RETURN_ORIGINS'))
	return deploy({
		appId: loaded.config.id,
		env: options.env,
		...(domain === undefined ? {} : { domain }),
		...(returnOrigins === undefined ? {} : { returnOrigins }),
		cwd: loaded.cwd,
		configPath: loaded.absolutePath,
		...(options.stateNamespace === undefined ? {} : { stateNamespace: options.stateNamespace }),
		secrets: declaredValues(loaded.config.pipeline?.secrets),
		vars: declaredValues(loaded.config.pipeline?.vars),
		managedEnvironment: requiredValues(options.managedVarNames),
		dryRun: options.dryRun ?? false,
		signal: options.signal ?? new AbortController().signal,
		log: options.log ?? ((line) => console.log(line)),
	})
}
