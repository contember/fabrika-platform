import { deploy } from '@fabrika/engine'
import type { ProviderDeployResult, ProviderRunEvents, RuntimeProviderRun } from '@fabrika/provider-contract'
import { resolve } from 'node:path'
import { type CloudflareAppConfig, isCloudflareAppConfig } from './authoring'
import { cloudflareArtifact } from './codec'
import { cloudflareProvider } from './provider'

const requiredEnvironmentValue = (name: string): string => {
	const value = process.env[name]
	if (value === undefined || value === '') {
		throw new Error(`Missing ${name} environment variable`)
	}
	return value
}

const declaredValues = (names: readonly string[] | undefined): Record<string, string> => {
	const values: Record<string, string> = {}
	for (const name of names ?? []) {
		const value = process.env[name]
		if (value !== undefined && value !== '') {
			values[name] = value
		}
	}
	return values
}

const requiredValues = (names: readonly string[] | undefined): Record<string, string> => {
	const values: Record<string, string> = {}
	for (const name of names ?? []) {
		values[name] = requiredEnvironmentValue(name)
	}
	return values
}

export interface LoadedCloudflareCommandConfig {
	readonly config: CloudflareAppConfig
	readonly absolutePath: string
	readonly cwd: string
}

export const loadCloudflareCommandConfig = async (configPath: string, cwd: string): Promise<LoadedCloudflareCommandConfig> => {
	const absolutePath = resolve(cwd, configPath)
	const loaded: unknown = await import(absolutePath)
	if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || !isCloudflareAppConfig(loaded.default)) {
		throw new Error(`Cloudflare config at ${absolutePath} must export a valid default defineApp(...) value`)
	}
	return { config: loaded.default, absolutePath, cwd: resolve(absolutePath, '..') }
}

export interface CloudflareCommandDeployOptions {
	readonly env: string
	readonly configPath?: string
	readonly cwd?: string
	readonly dryRun?: boolean
	readonly stateNamespace?: string
	readonly managedVarNames?: readonly string[]
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
	}
	const run: RuntimeProviderRun = {
		appId: loaded.config.id,
		env: options.env,
		...(process.env['VOZKA_DOMAIN'] === undefined ? {} : { domain: process.env['VOZKA_DOMAIN'] }),
		cwd: loaded.cwd,
		secrets: declaredValues(loaded.config.pipeline?.secrets),
		vars: declaredValues(loaded.config.pipeline?.vars),
		managedEnvironment: requiredValues(options.managedVarNames),
		dryRun: options.dryRun ?? false,
		signal: options.signal ?? new AbortController().signal,
		events,
		target: cloudflareProvider.encodeTarget({
			accountId: requiredEnvironmentValue('CLOUDFLARE_ACCOUNT_ID'),
			apiToken: requiredEnvironmentValue('CLOUDFLARE_API_TOKEN'),
			...(options.stateNamespace === undefined ? {} : { stateNamespace: options.stateNamespace }),
			...(process.env['PROPUSTKA_URL'] === undefined ? {} : { propustkaUrl: process.env['PROPUSTKA_URL'] }),
			...(process.env['PROPUSTKA_PROVISIONING_KEY'] === undefined
				? {}
				: { adminKey: process.env['PROPUSTKA_PROVISIONING_KEY'] }),
		}),
		artifact: cloudflareProvider.encodeArtifact(cloudflareArtifact(loaded.absolutePath)),
	}
	return deploy(cloudflareProvider.runtime, run)
}
