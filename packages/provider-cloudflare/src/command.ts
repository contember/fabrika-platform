import { type AppEnvironment, type ApplicationObjects, parseAppEnvironmentId, parseManagedEnvironment } from '@fabrika/auth-core'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { CloudflareAppConfig } from './authoring'
import { type CloudflareCollaborators, defaultCloudflareCollaborators, loadCloudflareConfig } from './collaborators'
import { buildCloudflareBundle, type CloudflareBuildResult, fetchCheckTools, parseBuildValues } from './isolated-build'
import { openPrebuiltApplication } from './isolated-deploy'
import { type CloudflareDeployResult, createCloudflareDeployer, type PlatformIamTarget } from './provider'
import {
	APPLICATION_OBJECTS_ENV,
	applicationObjectsSchema,
	APPROVED_ACCESS_FILE_ENV,
	CROSS_ORIGINS_ENV,
	DEPLOY_VALUES_FILE_ENV,
	IAM_SERVICE_ENV,
	INSTALLATION_APPS_ENV,
	isWorkerName,
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

/** Where the executor looks up an application-authored name: the runner's values file, or the environment outside a runner. */
export type DeployValueLookup = (name: string) => string | undefined

const declaredValues = (names: readonly string[] | undefined, lookup: DeployValueLookup): Record<string, string> => {
	const values: Record<string, string> = {}
	for (const name of names ?? []) {
		const value = lookup(name)
		if (value !== undefined && value !== '') {
			values[name] = value
		}
	}
	return values
}

const environmentValue = (name: string): string | undefined => process.env[name]

const requiredValues = (names: readonly string[] | undefined, lookup: DeployValueLookup): Record<string, string> => {
	const values: Record<string, string> = {}
	for (const name of names ?? []) {
		const value = lookup(name)
		if (value === undefined || value === '') throw new Error(`Missing ${name} value`)
		values[name] = value
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

/** Decode `FABRIKA_IAM_SERVICE`, IAM's Worker as Control names it. Undefined when absent; a malformed one fails the deploy. */
export const parseIamService = (raw: string | undefined): string | undefined => {
	if (raw === undefined || raw === '') return undefined
	if (!isWorkerName(raw)) throw new Error(`${IAM_SERVICE_ENV} is not a Worker name`)
	return raw
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

/**
 * The lookup for application-authored names. A runner names its values file in `FABRIKA_DEPLOY_VALUES_FILE`, and then
 * every secret, var and managed value comes from that file alone, never from the process environment; a deploy outside a
 * runner reads them from the environment. A file that is unreadable or malformed fails the deploy. Values never reach
 * an error message.
 */
export const readDeployValues = async (path: string | undefined): Promise<DeployValueLookup> => {
	if (path === undefined || path === '') return environmentValue
	let decoded: unknown
	try {
		decoded = JSON.parse(await readFile(path, 'utf8'))
	} catch {
		throw new Error(`${DEPLOY_VALUES_FILE_ENV} does not name a readable JSON file`)
	}
	if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
		throw new Error(`${DEPLOY_VALUES_FILE_ENV} does not hold an object of names to values`)
	}
	// A Map, so a name such as `__proto__` stays a name.
	const values = new Map<string, string>()
	for (const [name, value] of Object.entries(decoded)) {
		if (typeof value !== 'string') throw new Error(`${DEPLOY_VALUES_FILE_ENV} does not hold an object of names to values`)
		values.set(name, value)
	}
	return (name) => values.get(name)
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
	/** The platform deploy's namespace per component, by the config's app id; `stateNamespace` wins over it. */
	readonly stateNamespaces?: Readonly<Record<string, string>>
	readonly managedVarNames?: readonly string[]
	/** Defaults to `refuse`: only fabrika deploying its own components may name a platform resource. */
	readonly platformResources?: 'refuse' | 'allow'
	/** Where a platform deploy registers a component's schema (ADR-0058); only the installation sets it. */
	readonly platformIam?: PlatformIamTarget
	readonly signal?: AbortSignal
	readonly log?: (line: string) => void
}

/** What a deploy reads of its application: the config, the directory it runs in, and the path messages name. */
interface DeploySource {
	readonly config: CloudflareAppConfig
	readonly cwd: string
	readonly configPath: string
	readonly collaborators?: CloudflareCollaborators
	readonly prebuilt?: { readonly main: string }
}

/** Run the deployer over a loaded source, with the credentials, the job's values and Control's values from the environment. */
const deploySource = async (
	options: CloudflareCommandDeployOptions,
	source: DeploySource,
	approved: { readonly approved?: RunnerApprovedAccess },
	authored: DeployValueLookup,
): Promise<CloudflareDeployResult> => {
	const deploy = createCloudflareDeployer({
		accountId: requiredEnvironmentValue('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requiredEnvironmentValue('CLOUDFLARE_API_TOKEN'),
		platformResources: options.platformResources ?? 'refuse',
		...(options.platformIam === undefined ? {} : { platformIam: options.platformIam }),
		...(source.collaborators === undefined ? {} : { collaborators: source.collaborators }),
		...(source.prebuilt === undefined ? {} : { prebuilt: source.prebuilt }),
	})
	const domain = environmentValue('FABRIKA_CONTROL_DOMAIN')
	const returnOrigins = parseReturnOrigins(environmentValue('FABRIKA_IAM_RETURN_ORIGINS'))
	const installationApps = parseInstallationApps(environmentValue(INSTALLATION_APPS_ENV))
	const crossOrigins = parseCrossOrigins(environmentValue(CROSS_ORIGINS_ENV))
	const operationsOrigin = environmentValue(OPERATIONS_ORIGIN_ENV)
	const applicationObjects = parseApplicationObjectsEnvironment(environmentValue(APPLICATION_OBJECTS_ENV))
	const iamService = parseIamService(environmentValue(IAM_SERVICE_ENV))
	const stateNamespace = options.stateNamespace ?? options.stateNamespaces?.[source.config.id]
	return deploy({
		appId: source.config.id,
		env: options.env,
		...(domain === undefined ? {} : { domain }),
		...(crossOrigins === undefined ? {} : { crossOrigins }),
		...(operationsOrigin === undefined ? {} : { operationsOrigin }),
		...(returnOrigins === undefined ? {} : { returnOrigins }),
		...(installationApps === undefined ? {} : { installationApps }),
		...(applicationObjects === undefined ? {} : { applicationObjects }),
		...(iamService === undefined ? {} : { iamService }),
		...approved,
		cwd: source.cwd,
		configPath: source.configPath,
		...(stateNamespace === undefined ? {} : { stateNamespace }),
		secrets: declaredValues(source.config.pipeline?.secrets, authored),
		vars: declaredValues(source.config.pipeline?.vars, authored),
		// The runner hands what Control handed its job; parsed here, where it enters the executor.
		managedEnvironment: parseManagedEnvironment(requiredValues(options.managedVarNames, authored)),
		dryRun: options.dryRun ?? false,
		signal: options.signal ?? new AbortController().signal,
		log: options.log ?? ((line) => console.log(line)),
	})
}

/**
 * Deploy one config with the account credentials from the environment, and declared secrets and vars from
 * `readDeployValues`. Loading the config runs its code in this process, beside the credential: this is the path of a
 * local deploy and of the installation's own components. A runner deploys an application with `deployCloudflareBundle`.
 */
export const deployCloudflareConfig = async (options: CloudflareCommandDeployOptions): Promise<CloudflareDeployResult> => {
	const cwd = options.cwd ?? process.cwd()
	// Before the config runs: loading it executes the checkout's code.
	const approved = approvedRun(await readApprovedAccess(environmentValue(APPROVED_ACCESS_FILE_ENV)))
	const authored = await readDeployValues(environmentValue(DEPLOY_VALUES_FILE_ENV))
	const loaded = await loadCloudflareCommandConfig(options.configPath ?? './fabrika.config.ts', cwd)
	return deploySource(options, { config: loaded.config, cwd: loaded.cwd, configPath: loaded.absolutePath }, approved, authored)
}

export interface CloudflareBundleDeployOptions
	extends Omit<CloudflareCommandDeployOptions, 'configPath' | 'cwd' | 'platformResources' | 'platformIam'>
{
	/** The runner's own copy of the build's output (`copyBuildOutput`), never the directory the build wrote. */
	readonly bundleDir: string
}

/**
 * Deploy an application the build sandbox built (ADR-0086): the config is rebuilt from the build's manifest, the Worker
 * is the build's bundle, uploaded as it is. Nothing of the build is imported or evaluated, so the credential in this
 * process never meets the checkout's code. The approved access and the values come from the runner's files, as for any
 * deploy.
 */
export const deployCloudflareBundle = async (options: CloudflareBundleDeployOptions): Promise<CloudflareDeployResult> => {
	const approved = approvedRun(await readApprovedAccess(environmentValue(APPROVED_ACCESS_FILE_ENV)))
	const authored = await readDeployValues(environmentValue(DEPLOY_VALUES_FILE_ENV))
	const prebuilt = await openPrebuiltApplication(resolve(options.bundleDir), options.env)
	// The application is the one Control approved the contract of (it refuses a contract of another app), whatever the
	// build's manifest claims: the id names every resource and the IAM identity of the deploy.
	if (approved.approved !== undefined && approved.approved.contract.app !== prebuilt.config.id) {
		throw new Error(
			`cloudflare: the build describes application \`${prebuilt.config.id.slice(0, 63)}\`, but Control approved \`${approved.approved.contract.app}\``,
		)
	}
	const collaborators: CloudflareCollaborators = {
		...defaultCloudflareCollaborators,
		loadConfig: async () => ({ config: prebuilt.config, cwd: prebuilt.appDir }),
		// Only a run without approved access (a dry run) reads it: the contract the build read without running it.
		readContract: async () => prebuilt.contract,
	}
	return deploySource(
		{ ...options, platformResources: 'refuse' },
		{
			config: prebuilt.config,
			cwd: prebuilt.appDir,
			configPath: join(prebuilt.appDir, prebuilt.manifest.configFile),
			collaborators,
			prebuilt: { main: prebuilt.main },
		},
		approved,
		authored,
	)
}

export interface CloudflareBuildCommandOptions {
	readonly env: string
	readonly configPath?: string
	readonly cwd?: string
	readonly outDir: string
	readonly domain?: string
	/** The runner's copy of the approved access, readable in the sandbox; absent for a dry run without one. */
	readonly accessFile?: string
	/** The build values the runner wrote (`buildValuesOf`); absent, the build gets none. */
	readonly valuesFile?: string
	readonly dryRun?: boolean
	readonly signal?: AbortSignal
	readonly log?: (line: string) => void
}

/** The tools the checks run, fetched while the sandbox still has network; run outside the checkout. */
export const fetchCheckToolsCommand = async (
	options: { readonly accessFile?: string; readonly cwd?: string; readonly log?: (line: string) => void },
): Promise<void> => {
	await fetchCheckTools({
		approved: await readApprovedAccess(options.accessFile),
		cwd: options.cwd ?? process.cwd(),
		signal: new AbortController().signal,
		log: options.log ?? ((line) => console.log(line)),
	})
}

/** The build half, as the runner's sandbox runs it: no credential is read, and none is needed. */
export const buildCloudflareCommand = async (options: CloudflareBuildCommandOptions): Promise<CloudflareBuildResult> => {
	const approved = await readApprovedAccess(options.accessFile)
	const values = options.valuesFile === undefined || options.valuesFile === ''
		? { vars: {}, managed: {} }
		: parseBuildValues(await readFile(options.valuesFile, 'utf8'))
	return buildCloudflareBundle({
		env: options.env,
		configPath: options.configPath ?? './fabrika.config.ts',
		cwd: options.cwd ?? process.cwd(),
		outDir: resolve(options.outDir),
		...(options.domain === undefined || options.domain === '' ? {} : { domain: options.domain }),
		...(approved === undefined ? {} : { approved }),
		values,
		dryRun: options.dryRun ?? false,
		signal: options.signal ?? new AbortController().signal,
		log: options.log ?? ((line) => console.log(line)),
	})
}
