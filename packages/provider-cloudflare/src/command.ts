import { type AppEnvironment, type ContractArtifact, parseAppEnvironmentId } from '@fabrika/auth-core'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { CloudflareAppConfig } from './authoring'
import { loadCloudflareConfig } from './collaborators'
import { type CloudflareDeployResult, createCloudflareDeployer } from './provider'
import { APPROVED_ACCESS_FILE_ENV, INSTALLATION_APPS_ENV, type RunnerApprovedAccess, runnerApprovedAccessSchema } from './runner-protocol'

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

const installationAppsSchema = z.array(z.string())

/**
 * Decode `FABRIKA_INSTALLATION_APPS`, the Cloudflare deployments Control registered, as the runner writes it.
 * Undefined when absent; anything malformed fails the deploy rather than dropping the refusal it feeds.
 */
export const parseInstallationApps = (raw: string | undefined): readonly AppEnvironment[] | undefined => {
	if (raw === undefined || raw === '') return undefined
	let decoded: unknown
	try {
		decoded = JSON.parse(raw)
	} catch {
		throw new Error(`${INSTALLATION_APPS_ENV} is not a JSON array`)
	}
	const ids = installationAppsSchema.safeParse(decoded)
	if (!ids.success) throw new Error(`${INSTALLATION_APPS_ENV} is not a JSON array of strings`)
	return ids.data.map((id) => {
		const deployment = parseAppEnvironmentId(id)
		if (deployment === null) throw new Error(`${INSTALLATION_APPS_ENV} holds \`${id.slice(0, 80)}\`, which is not \`<app>@<env>\``)
		return deployment
	})
}

/**
 * Read the access Control approved for this run from the file at `FABRIKA_APPROVED_ACCESS_FILE`, as the runner
 * writes it. Undefined when no runner set it (a local deploy); a file that is unreadable or malformed fails the deploy
 * rather than falling back to the checkout.
 */
export const readApprovedAccess = async (path: string | undefined): Promise<RunnerApprovedAccess | undefined> => {
	if (path === undefined || path === '') return undefined
	let decoded: unknown
	try {
		decoded = JSON.parse(await readFile(path, 'utf8'))
	} catch {
		throw new Error(`${APPROVED_ACCESS_FILE_ENV} does not name a readable JSON file`)
	}
	const access = runnerApprovedAccessSchema.safeParse(decoded)
	if (!access.success) throw new Error(`${APPROVED_ACCESS_FILE_ENV} does not hold the access Control approved`)
	return access.data
}

/** The approved access as the deployer takes it: the contract (null when Control read none), and the artifact approval. */
const approvedRun = (
	access: RunnerApprovedAccess | undefined,
): { readonly contract?: ContractArtifact | null; readonly artifactApproval?: { readonly digest: string | null; readonly protected: boolean } } => {
	if (access === undefined) return {}
	if (access.kind === 'contract') return { contract: access.contract }
	return { contract: null, artifactApproval: { digest: access.digest, protected: access.protected } }
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
	// Before the config runs: loading it executes the checkout's code.
	const approved = approvedRun(await readApprovedAccess(environmentValue(APPROVED_ACCESS_FILE_ENV)))
	const loaded = await loadCloudflareCommandConfig(options.configPath ?? './fabrika.config.ts', cwd)
	const deploy = createCloudflareDeployer({
		accountId: requiredEnvironmentValue('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requiredEnvironmentValue('CLOUDFLARE_API_TOKEN'),
		platformResources: options.platformResources ?? 'refuse',
	})
	const domain = environmentValue('FABRIKA_CONTROL_DOMAIN')
	const returnOrigins = parseReturnOrigins(environmentValue('FABRIKA_IAM_RETURN_ORIGINS'))
	const installationApps = parseInstallationApps(environmentValue(INSTALLATION_APPS_ENV))
	return deploy({
		appId: loaded.config.id,
		env: options.env,
		...(domain === undefined ? {} : { domain }),
		...(returnOrigins === undefined ? {} : { returnOrigins }),
		...(installationApps === undefined ? {} : { installationApps }),
		...approved,
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
