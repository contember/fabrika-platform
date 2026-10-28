import { type AppEnvironment, type ApplicationObjects, parseAppEnvironmentId, parseManagedEnvironment } from '@fabrika/auth-core'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { type CloudflareAppConfig, configDatabase } from './authoring'
import { loadCloudflareConfig } from './collaborators'
import { type CloudflareDeployResult, createCloudflareDeployer, type PlatformIamTarget } from './provider'
import {
	APPLICATION_OBJECTS_ENV,
	applicationObjectsSchema,
	APPROVED_ACCESS_FILE_ENV,
	CROSS_ORIGINS_ENV,
	INSTALLATION_APPS_ENV,
	OPERATIONS_ORIGIN_ENV,
	type RunnerApprovedAccess,
	runnerApprovedAccessSchema,
} from './runner-protocol'

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
 * Decode `FABRIKA_IAM_RETURN_ORIGINS`, the comma-separated set the installation's workflow hands the
 * platform's own deploy (ADR-0022). Undefined for an absent or empty value, so a deploy with nothing to
 * project leaves IAM's registry alone rather than clearing it. Part of the executor's environment
 * contract, exported for the test that pins it; not part of the package's public surface.
 */
export const parseReturnOrigins = (raw: string | undefined): readonly string[] | undefined => {
	const origins = (raw ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
	return origins.length === 0 ? undefined : origins
}

const installationAppsSchema = z.array(z.string())
const crossOriginsSchema = z.array(z.string())

/**
 * Decode `FABRIKA_CROSS_ORIGINS`, the environment's cross-origin list as the runner writes it. Undefined when absent or
 * empty; anything malformed fails the deploy, and the proxy manifest's own parser judges each origin.
 */
export const parseCrossOrigins = (raw: string | undefined): readonly string[] | undefined => {
	if (raw === undefined || raw === '') return undefined
	let decoded: unknown
	try {
		decoded = JSON.parse(raw)
	} catch {
		throw new Error(`${CROSS_ORIGINS_ENV} is not a JSON array`)
	}
	const origins = crossOriginsSchema.safeParse(decoded)
	if (!origins.success) throw new Error(`${CROSS_ORIGINS_ENV} is not a JSON array of strings`)
	return origins.data.length === 0 ? undefined : origins.data
}

/**
 * Decode `FABRIKA_RUNNER_APPLICATION_OBJECTS`, the pointer Control recorded, as the runner writes it. Undefined when
 * absent, and the deployer writes its defaults; anything malformed fails the deploy rather than move ordinary traffic.
 */
export const parseApplicationObjectsEnvironment = (raw: string | undefined): ApplicationObjects | undefined => {
	if (raw === undefined || raw === '') return undefined
	let decoded: unknown
	try {
		decoded = JSON.parse(raw)
	} catch {
		throw new Error(`${APPLICATION_OBJECTS_ENV} is not JSON`)
	}
	const objects = applicationObjectsSchema.safeParse(decoded)
	if (!objects.success) throw new Error(`${APPLICATION_OBJECTS_ENV} is not a serving object and its object list`)
	return objects.data
}

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

/** The name of the secret holding the database's provisioning URL, for a config on Postgres. */
const provisioningSecret = (config: CloudflareAppConfig): readonly string[] => {
	const database = configDatabase(config.database)
	return database === null ? [] : [database.provisioningSecret]
}

/** The approved access as the deployer takes it: the contract Control read at the commit, and its application's digest. */
const approvedRun = (access: RunnerApprovedAccess | undefined): { readonly approved?: RunnerApprovedAccess } =>
	access === undefined ? {} : { approved: access }

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
	/** Where a platform deploy registers a component's schema (ADR-0058); only the installation sets it. */
	readonly platformIam?: PlatformIamTarget
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
		...(options.platformIam === undefined ? {} : { platformIam: options.platformIam }),
	})
	const domain = environmentValue('FABRIKA_CONTROL_DOMAIN')
	const returnOrigins = parseReturnOrigins(environmentValue('FABRIKA_IAM_RETURN_ORIGINS'))
	const installationApps = parseInstallationApps(environmentValue(INSTALLATION_APPS_ENV))
	const crossOrigins = parseCrossOrigins(environmentValue(CROSS_ORIGINS_ENV))
	const operationsOrigin = environmentValue(OPERATIONS_ORIGIN_ENV)
	const applicationObjects = parseApplicationObjectsEnvironment(environmentValue(APPLICATION_OBJECTS_ENV))
	return deploy({
		appId: loaded.config.id,
		env: options.env,
		...(domain === undefined ? {} : { domain }),
		...(crossOrigins === undefined ? {} : { crossOrigins }),
		...(operationsOrigin === undefined ? {} : { operationsOrigin }),
		...(returnOrigins === undefined ? {} : { returnOrigins }),
		...(installationApps === undefined ? {} : { installationApps }),
		...(applicationObjects === undefined ? {} : { applicationObjects }),
		...approved,
		cwd: loaded.cwd,
		configPath: loaded.absolutePath,
		...(options.stateNamespace === undefined ? {} : { stateNamespace: options.stateNamespace }),
		// The database's provisioning secret is the application's own and no Worker's: the deployer reads it, and keeps it in the runner.
		secrets: declaredValues([...(loaded.config.pipeline?.secrets ?? []), ...provisioningSecret(loaded.config)]),
		vars: declaredValues(loaded.config.pipeline?.vars),
		// The runner hands what Control handed its job; parsed here, where it enters the executor.
		managedEnvironment: parseManagedEnvironment(requiredValues(options.managedVarNames)),
		dryRun: options.dryRun ?? false,
		signal: options.signal ?? new AbortController().signal,
		log: options.log ?? ((line) => console.log(line)),
	})
}
