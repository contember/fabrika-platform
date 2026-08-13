// `fabrika platform init --provider=zerops <installation>` — configure source and maintain the operator's
// sidecar repository for an installation that ALREADY EXISTS.
//
// ── What this does, and the one thing it does not ─────────────────────────────────────────────────
//
// It creates the private source service when an older installation lacks it, reconciles its direct
// Zerops configuration, creates `<owner>/fabrika-zerops-<installation>`, pushes the pipeline that calls
// `fabrika platform deploy --provider=zerops`, writes the GitHub Environment that pipeline reads, and
// triggers it. It does NOT create the installation: `platform install` owns the first bring-up.
//
// ── It does the whole job, and confirms before every step that leaves this disk ───────────────────
//
// Reading the project, configuring source, creating or pushing the repository, writing the Environment,
// and triggering the workflow each ask first. Full automation, never silent. Declining stops the outward steps and prints what to run
// instead; `init` is idempotent, so the answer to a declined step is to run it again.
//
// ── Credentials ───────────────────────────────────────────────────────────────────────────────────
//
// Two deployment credentials, and this command generates neither. Both already belong to the
// installation. Source configuration is separate: a source RPC key is generated only when neither
// source nor control has one; a valid key on one side repairs the absent side. That RPC key is written
// directly to Zerops, never GitHub or disk. A newly created GitHub App's one-time bundle is the narrow
// exception: it is first persisted in an owner-only XDG recovery file, then deleted after durable
// Zerops credentials and exact App identity/webhook verification. No deployment token enters it.

import { GitHubAppClient, type GitHubAppIdentity, type GitHubAppWebhookConfig } from '@fabrika/github-app'
import {
	action as consoleAction,
	configureEnvironment,
	confirm as promptConfirm,
	type CreatedGitHubApp,
	createGitHubAppViaManifest,
	type EnvironmentConfig,
	ghRepoExists,
	githubAppInstallationUrl,
	info as consoleInfo,
	ok as consoleOk,
	scaffoldSidecarRepository,
	secretOrEnv,
	select as promptSelect,
	type SidecarScaffoldInput,
	type SidecarScaffoldResult,
	step as consoleStep,
	text as promptText,
	triggerPlatformWorkflow,
	url,
	warn as consoleWarn,
} from '@fabrika/installation-init'
import {
	compileProvisioningYaml,
	createZeropsApi,
	defaultSleep,
	type Sleeper,
	waitForProcess,
	type ZeropsApi,
	type ZeropsService,
} from '@fabrika/provider-zerops'
import { randomBytes } from 'node:crypto'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '../zerops/generated/platform-proxy-manifest'
import { sourceServiceSpec } from '../zerops/topology'
import {
	acquireGitHubAppRecoveryLock,
	classifyGitHubAppState,
	type GitHubAppCredentials,
	type GitHubAppRecovery,
	type GitHubAppRecoveryLock,
	type LiveGitHubAppState,
} from './github-app-recovery'
import { derivePlatformHosts, ZEROPS_SUBDOMAIN_VARIABLE } from './hosts'
import { FABRIKA_REPOSITORY_URL } from './install-options'
import type { InitLog } from './log'
import { assertPinnedTag, defaultCheckoutDir, defaultSidecarRepo, materializeSidecarScaffold, readPinnedTag, SIDECAR_FILES } from './sidecar'

/** The name every bypass in this platform is gated on, and therefore the one name an installation cannot take. */
const LOCAL_ENVIRONMENT = 'local'

/** Everything `runInit` asks the operator. Injected so the flow can be exercised without a TTY. */
export interface InitPrompts {
	text(question: string, fallback?: string): Promise<string>
	/** A non-secret prompt with an environment-variable fallback. */
	setting(variable: string, question: string, fallback?: string): Promise<string>
	confirm(question: string, defaultYes?: boolean): Promise<boolean>
	select<T>(question: string, options: { label: string; value: T }[]): Promise<T>
	/** A hidden prompt, or the named environment variable when it is already set. NEVER echoed. */
	secret(variable: string, question: string): Promise<string>
}

/** Everything `runInit` does outside the operator's own disk. Every one of them is confirmed first. */
export interface InitEffects {
	/** Only decides how the scaffold confirmation is phrased; the scaffold itself re-reads it. */
	repositoryExists(repo: string): Promise<boolean>
	scaffold(input: SidecarScaffoldInput): Promise<SidecarScaffoldResult>
	configureEnvironment(config: EnvironmentConfig): Promise<void>
	triggerWorkflow(repo: string): Promise<void>
	/** Read one Zerops project's name — the cheapest proof that the token and the project id agree. */
	describeProject(input: { projectId: string; accessToken: string; apiBaseUrl?: string }): Promise<string>
	configureSource(input: ConfigureSourceInput): Promise<ConfigureSourceResult>
	readServiceEnvironment(input: { serviceId: string; accessToken: string; apiBaseUrl?: string }): Promise<ReadonlyMap<string, string>>
	createServiceEnvironment(input: { serviceId: string; key: string; value: string; accessToken: string; apiBaseUrl?: string }): Promise<void>
	sleep(ms: number, signal: AbortSignal): Promise<void>
	acquireRecovery(projectId: string, installation: string): Promise<GitHubAppRecoveryLock>
	createGitHubApp(
		input: { organization: string; appName: string; homepageUrl: string; webhookUrl: string; public: boolean },
		onCreated: (app: CreatedGitHubApp, signal: AbortSignal) => Promise<void>,
	): Promise<CreatedGitHubApp>
	createGitHubClient(credentials: Pick<GitHubAppCredentials, 'id' | 'privateKeyPem'>): Promise<InitGitHubAppClient>
}

export interface InitGitHubAppClient {
	getAuthenticatedApp(signal?: AbortSignal): Promise<GitHubAppIdentity>
	updateWebhookConfig(input: { url: string; secret: string; signal?: AbortSignal }): Promise<GitHubAppWebhookConfig>
	getWebhookConfig(signal?: AbortSignal): Promise<GitHubAppWebhookConfig>
	resolveOrganizationInstallationId(organization: string, signal?: AbortSignal): Promise<number | null>
	resolveInstallationId(owner: string, repository: string, signal?: AbortSignal): Promise<number | null>
}

export interface InitCollaborators {
	readonly log: InitLog
	readonly prompts: InitPrompts
	readonly effects: InitEffects
}

/** `<installation>` plus the one optional flag, so the repository can be named without a prompt. */
export interface InitArguments {
	readonly installation: string
	readonly repo?: string
}

export const parseInitArgs = (argv: readonly string[]): InitArguments => {
	let installation: string | undefined
	let repo: string | undefined
	for (const arg of argv) {
		if (arg.startsWith('--repo=')) {
			repo = arg.slice('--repo='.length).trim()
			continue
		}
		if (arg.startsWith('-')) {
			throw new Error(`unexpected argument \`${arg}\`. Usage: fabrika platform init --provider=zerops <installation> [--repo=<owner>/<name>]`)
		}
		if (installation !== undefined) {
			throw new Error(`unexpected argument \`${arg}\`: name ONE installation`)
		}
		installation = arg.trim()
	}
	if (installation === undefined || installation === '') {
		throw new Error('Zerops installation init requires an installation name, for example `fabrika platform init --provider=zerops test`')
	}
	if (repo !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
		throw new Error(`\`${repo}\` is not a <owner>/<name> repository`)
	}
	return { installation, ...(repo === undefined || repo === '' ? {} : { repo }) }
}

/**
 * The installation's environment name, refused when it claims to be local.
 *
 * The same refusal the services enforce at boot: `local` is the value `localDevLogin`, the ephemeral
 * signing key and the credential-less caller path are all gated on, and a deployed installation is
 * never a loopback address. Refusing it here means the operator finds out at the prompt rather than in
 * a failed readiness check.
 */
export const checkedEnvironmentName = (declared: string): string => {
	const trimmed = declared.trim()
	if (trimmed === '') {
		throw new Error('an installation environment name is required — it is written to every service as ENVIRONMENT')
	}
	if (trimmed === LOCAL_ENVIRONMENT) {
		throw new Error(
			`\`${LOCAL_ENVIRONMENT}\` is refused: it is the name every development bypass is gated on, and a deployed `
				+ 'installation is not a loopback address. Name it after the installation instead',
		)
	}
	return trimmed
}

/** Where this installation answers, as far as `init` needs to know it. */
interface Placement {
	readonly hosts?: { readonly iam: string; readonly control: string; readonly operations: string }
}

/** Everything collected before anything leaves this disk. */
interface Collected {
	readonly repo: string
	readonly fabrikaRef: string
	readonly projectId: string
	readonly environmentName: string
	readonly placement: Placement
	readonly buildFromGit?: string
	readonly apiBaseUrl?: string
	readonly accessToken: string
	readonly provisioningKey: string
	readonly requestedRepositories: readonly GitHubRepository[]
}

export interface ConfigureSourceInput {
	readonly projectId: string
	readonly environment: string
	readonly accessToken: string
	readonly apiBaseUrl?: string
}

export interface ConfigureSourceResult {
	readonly created: boolean
	readonly reusedRpcKey: boolean
	readonly writtenKeys: readonly string[]
	readonly sourceServiceId: string
	readonly controlServiceId: string
	readonly proxyServiceId: string
	readonly sourceEnv: ReadonlyMap<string, string>
	readonly controlEnv: ReadonlyMap<string, string>
	readonly proxyEnv: ReadonlyMap<string, string>
	readonly proxyPublished: boolean
}

export interface GitHubRepository {
	readonly owner: string
	readonly repository: string
}

type GitHubAppMode = 'create' | 'existing' | 'anonymous'

interface GitHubInstallationPlan {
	readonly client: InitGitHubAppClient
	readonly identity: GitHubAppIdentity
	readonly repositories: readonly GitHubRepository[]
}

const requiredAnswer = async (prompts: InitPrompts, question: string, fallback?: string): Promise<string> => {
	const answer = (await prompts.text(question, fallback)).trim()
	if (answer === '') {
		throw new Error(`${question} is required`)
	}
	return answer
}

const bareHost = (value: string, label: string): string => {
	const host = value.trim()
	if (host === '' || host.includes('/') || host.includes(':')) {
		throw new Error(`\`${value}\` is not a bare hostname — ${label} carries no scheme and no port`)
	}
	return host
}

const REPOSITORY_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]+$/
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

export const parseGitHubRepositories = (value: string): GitHubRepository[] => {
	const repositories = new Map<string, GitHubRepository>()
	for (const item of value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
		const parts = item.split('/')
		const owner = parts[0]
		const repository = parts[1]
		if (
			parts.length !== 2 || owner === undefined || repository === undefined || owner === '.' || owner === '..' || repository === '.'
			|| repository === '..' || owner.length > 39 || repository.length > 100 || !GITHUB_OWNER_PATTERN.test(owner)
			|| !REPOSITORY_COMPONENT_PATTERN.test(repository)
		) throw new Error(`\`${item}\` is not a GitHub <owner>/<repository>`)
		const key = `${owner.toLowerCase()}/${repository.toLowerCase()}`
		if (!repositories.has(key)) repositories.set(key, { owner, repository })
	}
	return [...repositories.values()]
}

const collect = async (args: InitArguments, { log, prompts }: InitCollaborators): Promise<Collected> => {
	log.step('The installation this repository will deploy')
	log.info('Nothing leaves this machine until every question below is answered.')
	const repo = args.repo ?? await requiredAnswer(prompts, 'Sidecar repository (<owner>/<name>)', defaultSidecarRepo(args.installation))
	// Refused HERE, before the credential prompts and long before anything is created: a branch pin is a
	// question for the operator, not a failure in their CI.
	const fabrikaRef = assertPinnedTag(await requiredAnswer(prompts, 'fabrika-platform tag to pin (a published tag, never a branch)'))
	const projectId = await requiredAnswer(prompts, 'Zerops project id (the project holding iam, operations, proxy and control)')
	const environmentName = checkedEnvironmentName(await requiredAnswer(prompts, 'Installation environment name', args.installation))

	const custom = await prompts.select('Where does this installation answer?', [
		{ label: 'Zerops subdomains — derived from the proxy, and the deploy publishes them', value: false },
		{ label: 'Custom domains — bound to the project balancer out of band', value: true },
	])
	const placement: Placement = custom
		? {
			hosts: {
				iam: bareHost(await requiredAnswer(prompts, 'IAM hostname'), 'a platform host'),
				control: bareHost(await requiredAnswer(prompts, 'Console hostname'), 'a platform host'),
				operations: bareHost(await requiredAnswer(prompts, 'Operations ingest hostname'), 'a platform host'),
			},
		}
		: {}

	const buildFromGit = (await prompts.text(
		"Public repository Zerops builds each service from (blank = the service's own repository integration)",
		FABRIKA_REPOSITORY_URL,
	)).trim()
	const apiBaseUrl = (await prompts.text('Zerops region API base (blank = the default region)', '')).trim()

	log.step('Credentials')
	log.info('Both already belong to the installation. Neither is generated here, printed, or written to disk;')
	log.info('each is sent to GitHub over `gh` stdin and reaches the deploy as an Environment secret.')
	const accessToken = await prompts.secret(
		'FABRIKA_ZEROPS_ACCESS_TOKEN',
		"Zerops access token (an INTEGRATION token scoped to this installation's projects, never a personal one)",
	)
	const provisioningKey = await prompts.secret(
		'FABRIKA_IAM_PROVISIONING_KEY',
		"IAM provisioning key (the px_ admin key this installation's IAM already holds)",
	)
	const requestedRepositories = parseGitHubRepositories(
		await prompts.text('Application repositories the GitHub App must access (comma-separated owner/repo; blank = none)', ''),
	)
	if (accessToken.trim() === '' || provisioningKey.trim() === '') {
		throw new Error('both credentials are required: the deploy authenticates to Zerops and to IAM with them')
	}

	return {
		repo,
		fabrikaRef,
		projectId,
		environmentName,
		placement,
		accessToken: accessToken.trim(),
		provisioningKey: provisioningKey.trim(),
		requestedRepositories,
		...(buildFromGit === '' ? {} : { buildFromGit }),
		...(apiBaseUrl === '' ? {} : { apiBaseUrl }),
	}
}

const rpcKeyValid = (value: string | undefined): value is string => value !== undefined && value.length >= 32 && value.length <= 4096

const generateSourceRpcKey = (): string => {
	for (;;) {
		const value = randomBytes(32).toString('base64url')
		if (!value.startsWith('-') && !value.startsWith('_')) return value
	}
}

const oneService = (services: readonly ZeropsService[], name: string): ZeropsService | undefined => {
	const matches = services.filter((service) => service.name === name)
	if (matches.length > 1) throw new Error(`Zerops project has ${matches.length} services named \`${name}\``)
	return matches[0]
}

const sourceProvisioningImport = (environment: string): string =>
	compileProvisioningYaml({ target: { platform: 'zerops', services: () => [sourceServiceSpec()] }, ctx: { env: environment } }).yaml

/** Add/configure the private source service without persisting any credential outside Zerops. */
export const configureSourceService = async (
	input: Omit<ConfigureSourceInput, 'accessToken' | 'apiBaseUrl'>,
	api: ZeropsApi,
	sleep: Sleeper,
	signal: AbortSignal,
): Promise<ConfigureSourceResult> => {
	let services = await api.listProjectServices({ projectId: input.projectId, signal })
	for (const name of ['iam', 'operations', 'proxy', 'control']) {
		const service = oneService(services, name)
		if (service === undefined || service.id === '') throw new Error(`Zerops project ${input.projectId} has no \`${name}\` service`)
	}
	let source = oneService(services, 'source')
	let created = false
	if (source?.status === 'NEW') {
		throw new Error('Zerops is still creating `source`; run init again after its import process finishes')
	}
	if (source === undefined) {
		const result = await api.importServices({ projectId: input.projectId, yaml: sourceProvisioningImport(input.environment), signal })
		const imported = result.services.find((service) => service.name === 'source')
		if (imported === undefined || imported.processes.length === 0) throw new Error('the source import returned no source process')
		for (const process of imported.processes) {
			await waitForProcess({ api, processId: process.id, sleep, signal, label: 'the source import' })
		}
		services = await api.listProjectServices({ projectId: input.projectId, signal })
		source = oneService(services, 'source')
		if (source === undefined || source.id === '') throw new Error('Zerops created no `source` service after its import completed')
		created = true
	}
	const control = oneService(services, 'control')
	if (control === undefined || control.id === '') throw new Error(`Zerops project ${input.projectId} has no \`control\` service`)
	const proxy = oneService(services, 'proxy')
	if (proxy === undefined || proxy.id === '') throw new Error(`Zerops project ${input.projectId} has no \`proxy\` service`)
	const sourceEnv = new Map((await api.listServiceEnv({ serviceId: source.id, signal })).map((item) => [item.key, item.content]))
	const controlEnv = new Map((await api.listServiceEnv({ serviceId: control.id, signal })).map((item) => [item.key, item.content]))
	const proxyEnv = new Map((await api.listServiceEnv({ serviceId: proxy.id, signal })).map((item) => [item.key, item.content]))
	const sourceRpcKey = sourceEnv.get('FABRIKA_SOURCE_RPC_KEY')
	const controlRpcKey = controlEnv.get('FABRIKA_ZEROPS_SOURCE_RPC_KEY')
	let rpcKey: string
	let reusedRpcKey = false
	if (sourceRpcKey === undefined && controlRpcKey === undefined) {
		rpcKey = generateSourceRpcKey()
	} else if (rpcKeyValid(sourceRpcKey) && controlRpcKey === undefined) {
		rpcKey = sourceRpcKey
		reusedRpcKey = true
	} else if (sourceRpcKey === undefined && rpcKeyValid(controlRpcKey)) {
		rpcKey = controlRpcKey
		reusedRpcKey = true
	} else {
		if (!rpcKeyValid(sourceRpcKey) || !rpcKeyValid(controlRpcKey) || sourceRpcKey !== controlRpcKey) {
			throw new Error('source and control do not hold one matching valid source RPC key; refusing to rotate either side')
		}
		rpcKey = sourceRpcKey
		reusedRpcKey = true
	}
	const desired: Array<{ serviceId: string; service: string; key: string; value: string; live: Map<string, string> }> = [
		{ serviceId: source.id, service: 'source', key: 'FABRIKA_SOURCE_RPC_KEY', value: rpcKey, live: sourceEnv },
		{ serviceId: control.id, service: 'control', key: 'FABRIKA_ZEROPS_SOURCE_RPC_KEY', value: rpcKey, live: controlEnv },
		{ serviceId: control.id, service: 'control', key: 'FABRIKA_ZEROPS_PROJECT_ID', value: input.projectId, live: controlEnv },
	]
	const writtenKeys: string[] = []
	for (const item of desired) {
		if (item.live.get(item.key) === item.value) continue
		try {
			await api.createServiceEnv({ serviceId: item.serviceId, key: item.key, value: item.value, signal })
		} catch {
			const reread = new Map((await api.listServiceEnv({ serviceId: item.serviceId, signal })).map((value) => [value.key, value.content]))
			if (reread.get(item.key) !== item.value) throw new Error('source RPC configuration conflicts with a live Zerops value')
		}
		writtenKeys.push(`${item.service}.${item.key}`)
	}
	const finalSourceEnv = new Map((await api.listServiceEnv({ serviceId: source.id, signal })).map((item) => [item.key, item.content]))
	const finalControlEnv = new Map((await api.listServiceEnv({ serviceId: control.id, signal })).map((item) => [item.key, item.content]))
	if (finalSourceEnv.get('FABRIKA_SOURCE_RPC_KEY') !== rpcKey || finalControlEnv.get('FABRIKA_ZEROPS_SOURCE_RPC_KEY') !== rpcKey) {
		throw new Error('source and control did not retain one matching source RPC key')
	}
	if (finalControlEnv.get('FABRIKA_ZEROPS_PROJECT_ID') !== input.projectId) {
		throw new Error('control did not retain the exact Zerops platform project id')
	}
	return {
		created,
		reusedRpcKey,
		writtenKeys,
		sourceServiceId: source.id,
		controlServiceId: control.id,
		proxyServiceId: proxy.id,
		sourceEnv: finalSourceEnv,
		controlEnv: finalControlEnv,
		proxyEnv,
		proxyPublished: proxy.subdomainAccess === true,
	}
}

const controlOrigin = (collected: Collected, source: ConfigureSourceResult): string => {
	const liveHost = source.controlEnv.get('FABRIKA_CONTROL_DOMAIN')
	if (liveHost === undefined) {
		throw new Error('the live control service has no configured public domain; deploy the platform before configuring GitHub')
	}
	const host = bareHost(liveHost, 'the live control domain')
	if (collected.placement.hosts !== undefined) {
		if (collected.placement.hosts.control !== host) {
			throw new Error('the requested console hostname does not match the live control domain; refusing to configure a webhook for the wrong origin')
		}
		return `https://${host}`
	}
	if (!source.proxyPublished) throw new Error('the proxy is not published on its Zerops subdomain; deploy the platform before configuring GitHub')
	const subdomains = source.proxyEnv.get(ZEROPS_SUBDOMAIN_VARIABLE)
	if (subdomains === undefined || subdomains.trim() === '') throw new Error('the published proxy has no generated Zerops subdomain')
	const listeners = PLATFORM_PROXY_MANIFEST_TEMPLATE.apps.map((app) => ({ service: app.service, port: app.port }))
	const derived = derivePlatformHosts(subdomains, listeners).control
	if (derived !== host) throw new Error('the live control domain does not match the proxy control listener; refusing to guess the webhook origin')
	return `https://${host}`
}

const liveGitHubState = (sourceEnv: ReadonlyMap<string, string>, controlEnv: ReadonlyMap<string, string>): LiveGitHubAppState => {
	const appId = sourceEnv.get('GITHUB_APP_ID')
	const privateKeyPem = sourceEnv.get('GITHUB_APP_PRIVATE_KEY')
	const webhookSecret = controlEnv.get('GITHUB_WEBHOOK_SECRET')
	return {
		...(appId === undefined ? {} : { appId }),
		...(privateKeyPem === undefined ? {} : { privateKeyPem }),
		...(webhookSecret === undefined ? {} : { webhookSecret }),
	}
}

const credentialsFromCreated = (app: CreatedGitHubApp): GitHubAppCredentials => ({
	id: String(app.id),
	slug: app.slug,
	htmlUrl: app.htmlUrl,
	privateKeyPem: app.pem,
	webhookSecret: app.webhookSecret,
})

const verifiedCredentials = async (
	client: InitGitHubAppClient,
	credentials: GitHubAppCredentials,
	expected: { readonly owner?: string; readonly public?: boolean },
	signal: AbortSignal,
): Promise<{ readonly credentials: GitHubAppCredentials; readonly identity: GitHubAppIdentity }> => {
	const identity = await client.getAuthenticatedApp(signal)
	if (
		String(identity.id) !== credentials.id || identity.owner.type !== 'Organization'
		|| (expected.owner !== undefined && identity.owner.login.toLowerCase() !== expected.owner.toLowerCase())
		|| (expected.public !== undefined && identity.public !== expected.public)
	) throw new Error('GitHub App identity does not match the requested installation')
	return {
		identity,
		credentials: { ...credentials, slug: identity.slug, htmlUrl: identity.htmlUrl },
	}
}

const readCredentialState = async (
	collected: Collected,
	source: ConfigureSourceResult,
	effects: InitEffects,
): Promise<
	{ readonly sourceEnv: ReadonlyMap<string, string>; readonly controlEnv: ReadonlyMap<string, string>; readonly live: LiveGitHubAppState }
> => {
	const sourceEnv = await effects.readServiceEnvironment({
		serviceId: source.sourceServiceId,
		accessToken: collected.accessToken,
		...(collected.apiBaseUrl === undefined ? {} : { apiBaseUrl: collected.apiBaseUrl }),
	})
	const controlEnv = await effects.readServiceEnvironment({
		serviceId: source.controlServiceId,
		accessToken: collected.accessToken,
		...(collected.apiBaseUrl === undefined ? {} : { apiBaseUrl: collected.apiBaseUrl }),
	})
	return { sourceEnv, controlEnv, live: liveGitHubState(sourceEnv, controlEnv) }
}

const writeCredential = async (
	input: { readonly serviceId: string; readonly key: string; readonly value: string; readonly service: 'source' | 'control' },
	collected: Collected,
	source: ConfigureSourceResult,
	effects: InitEffects,
	signal: AbortSignal,
): Promise<void> => {
	let writeFailed = false
	try {
		await effects.createServiceEnvironment({
			serviceId: input.serviceId,
			key: input.key,
			value: input.value,
			accessToken: collected.accessToken,
			...(collected.apiBaseUrl === undefined ? {} : { apiBaseUrl: collected.apiBaseUrl }),
		})
	} catch {
		writeFailed = true
	}
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const state = await readCredentialState(collected, source, effects).catch(() => undefined)
		const live = input.service === 'source' ? state?.sourceEnv.get(input.key) : state?.controlEnv.get(input.key)
		if (live === input.value) return
		if (live !== undefined && live !== input.value) {
			throw new Error('GitHub App configuration conflicts with a live Zerops value; nothing was overwritten')
		}
		if (attempt < 7) await effects.sleep(500, signal)
	}
	throw new Error(
		writeFailed
			? 'Zerops did not confirm whether a GitHub App credential write succeeded'
			: 'Zerops did not expose the GitHub App credential after writing it',
	)
}

const reconcileCredentials = async (
	credentials: GitHubAppCredentials,
	collected: Collected,
	source: ConfigureSourceResult,
	effects: InitEffects,
	signal: AbortSignal,
): Promise<void> => {
	const desired: Array<{ readonly serviceId: string; readonly service: 'source' | 'control'; readonly key: string; readonly value: string }> = [
		{ serviceId: source.sourceServiceId, service: 'source', key: 'GITHUB_APP_PRIVATE_KEY', value: credentials.privateKeyPem },
		{ serviceId: source.sourceServiceId, service: 'source', key: 'GITHUB_APP_ID', value: credentials.id },
		{ serviceId: source.controlServiceId, service: 'control', key: 'GITHUB_WEBHOOK_SECRET', value: credentials.webhookSecret },
	]
	for (const item of desired) {
		const state = await readCredentialState(collected, source, effects)
		const live = item.service === 'source' ? state.sourceEnv.get(item.key) : state.controlEnv.get(item.key)
		if (live === item.value) continue
		if (live !== undefined) throw new Error('GitHub App configuration conflicts with a live Zerops value; nothing was overwritten')
		await writeCredential(item, collected, source, effects, signal)
	}
}

const verifyStableCredentials = async (
	credentials: GitHubAppCredentials,
	collected: Collected,
	source: ConfigureSourceResult,
	effects: InitEffects,
	signal: AbortSignal,
): Promise<void> => {
	const expectedRpcKey = source.sourceEnv.get('FABRIKA_SOURCE_RPC_KEY')
	if (expectedRpcKey === undefined || source.controlEnv.get('FABRIKA_ZEROPS_SOURCE_RPC_KEY') !== expectedRpcKey) {
		throw new Error('source RPC configuration is not stable')
	}
	for (let observation = 0; observation < 3; observation += 1) {
		const state = await readCredentialState(collected, source, effects)
		if (
			state.sourceEnv.get('FABRIKA_SOURCE_RPC_KEY') !== expectedRpcKey
			|| state.controlEnv.get('FABRIKA_ZEROPS_SOURCE_RPC_KEY') !== expectedRpcKey
			|| state.live.appId !== credentials.id || state.live.privateKeyPem !== credentials.privateKeyPem
			|| state.live.webhookSecret !== credentials.webhookSecret
		) throw new Error('Zerops credential state changed during final verification')
		if (observation < 2) await effects.sleep(500, signal)
	}
}

const requiredSecret = async (prompts: InitPrompts, variable: string, question: string): Promise<string> => {
	const value = (await prompts.secret(variable, question)).trim()
	if (value === '') throw new Error(`${variable} is required for an existing GitHub App`)
	return value
}

const configureGitHubApp = async (
	installation: string,
	collected: Collected,
	source: ConfigureSourceResult,
	origin: string,
	recoveryLock: GitHubAppRecoveryLock,
	selectedMode: Exclude<GitHubAppMode, 'anonymous'> | undefined,
	{ prompts, effects }: InitCollaborators,
	signal: AbortSignal,
): Promise<GitHubInstallationPlan> => {
	const binding = { installation, projectId: collected.projectId, controlOrigin: origin }
	const recovery = await recoveryLock.read(binding)
	const observed = await readCredentialState(collected, source, effects)
	let decision = classifyGitHubAppState(observed.live, recovery)
	let expectedIdentity: { readonly owner?: string; readonly public?: boolean } = recovery === undefined
		? {}
		: { owner: recovery.owner, public: recovery.public }
	if (decision.kind === 'conflict') throw new Error('GitHub App credentials are partial or conflict with recovery state; no value was changed')
	if (decision.kind === 'create') {
		if (selectedMode === undefined) throw new Error('GitHub App mode was not selected for empty live state')
		const mode = selectedMode
		if (mode === 'existing') {
			const candidate: GitHubAppCredentials = {
				id: await requiredAnswer(prompts, 'Existing GitHub App id'),
				slug: '',
				htmlUrl: '',
				privateKeyPem: await requiredSecret(prompts, 'GITHUB_APP_PRIVATE_KEY', 'Existing GitHub App private key'),
				webhookSecret: await requiredSecret(prompts, 'GITHUB_WEBHOOK_SECRET', 'Existing webhook secret already configured on the App'),
			}
			const client = await effects.createGitHubClient(candidate)
			const verified = await verifiedCredentials(client, candidate, {}, signal)
			const createdRecovery: GitHubAppRecovery = {
				version: 1,
				...binding,
				owner: verified.identity.owner.login,
				public: verified.identity.public,
				app: verified.credentials,
			}
			await recoveryLock.write(createdRecovery, signal)
			expectedIdentity = { owner: verified.identity.owner.login, public: verified.identity.public }
			decision = { kind: 'resume', credentials: verified.credentials }
		} else {
			const owner = await requiredAnswer(prompts, 'GitHub organization that will own the App')
			if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) throw new Error('GitHub organization is invalid')
			const crossOrganization = collected.requestedRepositories.some((repository) => repository.owner.toLowerCase() !== owner.toLowerCase())
			let publicApp = false
			if (crossOrganization) {
				publicApp = await prompts.confirm('Requested repositories cross organization boundaries. Create a PUBLIC GitHub App?', false)
				if (!publicApp) throw new Error('cross-organization repositories require an explicitly public GitHub App')
			}
			const appName = await requiredAnswer(prompts, 'GitHub App name', `fabrika-${installation}`)
			const app = await effects.createGitHubApp(
				{ organization: owner, appName, homepageUrl: origin, webhookUrl: `${origin}/webhooks/github`, public: publicApp },
				async (created, persistenceSignal) => {
					await recoveryLock.write({ version: 1, ...binding, owner, public: publicApp, app: credentialsFromCreated(created) }, persistenceSignal)
				},
			)
			expectedIdentity = { owner, public: publicApp }
			decision = { kind: 'resume', credentials: credentialsFromCreated(app) }
		}
	}
	let credentials = decision.credentials
	let client = await effects.createGitHubClient(credentials)
	const initiallyVerified = await verifiedCredentials(client, credentials, expectedIdentity, signal)
	credentials = initiallyVerified.credentials
	if (
		!initiallyVerified.identity.public
		&& collected.requestedRepositories.some((repository) => repository.owner.toLowerCase() !== initiallyVerified.identity.owner.login.toLowerCase())
	) throw new Error('a private GitHub App cannot access requested repositories outside its owner organization')
	if (decision.kind === 'resume') await reconcileCredentials(credentials, collected, source, effects, signal)
	await verifyStableCredentials(credentials, collected, source, effects, signal)
	client = await effects.createGitHubClient(credentials)
	const identity = await verifiedCredentials(client, credentials, {
		owner: initiallyVerified.identity.owner.login,
		public: initiallyVerified.identity.public,
	}, signal)
	const webhookUrl = `${origin}/webhooks/github`
	await client.updateWebhookConfig({ url: webhookUrl, secret: credentials.webhookSecret, signal })
	const webhook = await client.getWebhookConfig(signal)
	if (webhook.url !== webhookUrl || webhook.contentType !== 'json' || webhook.insecureSsl !== '0') {
		throw new Error('GitHub App webhook configuration did not read back exactly')
	}
	await verifiedCredentials(client, credentials, { owner: identity.identity.owner.login, public: identity.identity.public }, signal)
	await recoveryLock.delete(binding, credentials)
	return { client, identity: identity.identity, repositories: collected.requestedRepositories }
}

const verifyGitHubInstallation = async (
	plan: GitHubInstallationPlan,
	{ log, prompts }: InitCollaborators,
	signal: AbortSignal,
): Promise<void> => {
	log.action('OPERATOR ACTION — install the GitHub App', [
		`1. Open: ${url(githubAppInstallationUrl(plan.identity.slug))}`,
		plan.repositories.length === 0
			? `2. Install it on the ${plan.identity.owner.login} organization; repository grants can be selected now or during onboarding.`
			: `2. Grant access to: ${plan.repositories.map((repository) => `${repository.owner}/${repository.repository}`).join(', ')}`,
	])
	if (!(await prompts.confirm('Has the GitHub App been installed with the requested access?', false))) {
		throw new Error('GitHub App installation is required before repository deploys can run')
	}
	if (plan.repositories.length === 0) {
		if (await plan.client.resolveOrganizationInstallationId(plan.identity.owner.login, signal) === null) {
			throw new Error(`GitHub App is not installed on the ${plan.identity.owner.login} organization`)
		}
		return
	}
	for (const repository of plan.repositories) {
		if (await plan.client.resolveInstallationId(repository.owner, repository.repository, signal) === null) {
			throw new Error(`GitHub App installation is incomplete for ${repository.owner}/${repository.repository}`)
		}
	}
}

/** The Environment the generated workflow reads. Secret VALUES appear here and nowhere else. */
const environmentConfig = (installation: string, collected: Collected): EnvironmentConfig => ({
	repo: collected.repo,
	environment: installation,
	secrets: {
		FABRIKA_ZEROPS_ACCESS_TOKEN: collected.accessToken,
		FABRIKA_IAM_PROVISIONING_KEY: collected.provisioningKey,
	},
	vars: {
		FABRIKA_ZEROPS_PROJECT_ID: collected.projectId,
		FABRIKA_PLATFORM_ENVIRONMENT: collected.environmentName,
		// Stated rather than defaulted, so the Environment describes the whole deploy.
		FABRIKA_PLATFORM_SCHEME: 'https',
		...(collected.placement.hosts === undefined ? {} : {
			FABRIKA_PLATFORM_IAM_HOST: collected.placement.hosts.iam,
			FABRIKA_PLATFORM_CONSOLE_HOST: collected.placement.hosts.control,
			FABRIKA_PLATFORM_OPERATIONS_HOST: collected.placement.hosts.operations,
		}),
		...(collected.buildFromGit === undefined ? {} : { FABRIKA_ZEROPS_BUILD_FROM_GIT: collected.buildFromGit }),
		...(collected.apiBaseUrl === undefined ? {} : { FABRIKA_ZEROPS_API_URL: collected.apiBaseUrl }),
	},
})

/** Read the project back, so a wrong token or a mistyped id fails here rather than in someone's CI. */
const verifyProject = async (collected: Collected, { log, prompts, effects }: InitCollaborators): Promise<void> => {
	log.step('Check the token against the project')
	if (!(await prompts.confirm(`Read Zerops project ${collected.projectId} to check the access token and the id?`, true))) {
		log.info('Skipped. A wrong token or project id will surface in the first pipeline run instead.')
		return
	}
	// A caught error is never re-thrown as itself: it may quote a request URL or a platform payload, and
	// this is the one step holding both credentials. A short sentence naming the two causes is enough.
	const name = await effects.describeProject({
		projectId: collected.projectId,
		accessToken: collected.accessToken,
		...(collected.apiBaseUrl === undefined ? {} : { apiBaseUrl: collected.apiBaseUrl }),
	}).catch(() => {
		throw new Error(
			`Zerops project ${collected.projectId} could not be read: the access token does not grant it, or the id is wrong. `
				+ 'Nothing has been created — check both and run init again',
		)
	})
	log.ok(`Zerops project ${name} (${collected.projectId}) is readable with this token.`)
}

const withRecoveryLock = async <T>(lock: GitHubAppRecoveryLock, operation: () => Promise<T>): Promise<T> => {
	let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
	try {
		outcome = { ok: true, value: await operation() }
	} catch (error) {
		outcome = { ok: false, error }
	}
	try {
		await lock.release()
	} catch {
		if (outcome.ok) throw new Error('the Zerops init lock could not be released')
	}
	if (!outcome.ok) throw outcome.error
	return outcome.value
}

/**
 * Create or refresh the sidecar repository — the first step that leaves this disk.
 *
 * Returns the local checkout, or `undefined` when the operator declined, which stops every later
 * outward step: an Environment cannot be written to a repository that does not exist, and a workflow
 * cannot be triggered without one.
 */
const scaffold = async (
	installation: string,
	collected: Collected,
	{ log, prompts, effects }: InitCollaborators,
): Promise<string | undefined> => {
	log.step('Scaffold the sidecar repository')
	const exists = await effects.repositoryExists(collected.repo)
	const question = exists
		? `Refresh the pipeline on ${collected.repo} and push?`
		: `Create ${collected.repo} (private) on GitHub and push the pipeline?`
	if (!(await prompts.confirm(question, true))) {
		log.action('OPERATOR ACTION — nothing was created; run init again when ready', [
			`fabrika platform init --provider=zerops ${installation} --repo=${collected.repo}`,
		])
		return undefined
	}
	const dir = defaultCheckoutDir(installation)
	const result = await effects.scaffold({
		repo: collected.repo,
		dir,
		files: [...SIDECAR_FILES],
		materialize: (target) =>
			materializeSidecarScaffold(target, {
				installation,
				repo: collected.repo,
				fabrikaRef: collected.fabrikaRef,
			}),
	})
	const pinned = await readPinnedTag(result.dir)
	log.ok(`${collected.repo} ${result.created ? 'created' : 'refreshed'} — pinned fabrika tag ${pinned}`)
	if (pinned !== collected.fabrikaRef) {
		log.warn(`the existing pin ${pinned} was kept; ${collected.fabrikaRef} was not written, because fabrika.ref is operator-owned`)
	}
	return result.dir
}

/** Run the whole thing for `<installation>`. */
export const runInit = async (args: InitArguments, collaborators: InitCollaborators): Promise<void> => {
	const { log, prompts, effects } = collaborators
	log.info(`fabrika platform init — the ${args.installation} Zerops installation's sidecar repository`)
	log.info('This UPDATES an installation that already exists. It does not create one.')

	const collected = await collect(args, collaborators)
	await verifyProject(collected, collaborators)
	const recoveryLock = await effects.acquireRecovery(collected.projectId, args.installation)
	const sourceStage = await withRecoveryLock(recoveryLock, async (): Promise<
		{ readonly continued: false } | { readonly continued: true; readonly installation?: GitHubInstallationPlan }
	> => {
		log.step('Configure the private source service')
		log.info('This writes credentials only to Zerops: the GitHub App key stays on source, and the webhook secret stays on control.')
		if (!(await prompts.confirm(`Create or configure \`source\` in Zerops project ${collected.projectId}?`, true))) {
			log.action('OPERATOR ACTION — source was not changed; run init again to continue', [
				`fabrika platform init --provider=zerops ${args.installation} --repo=${collected.repo}`,
			])
			return { continued: false }
		}
		const result = await effects.configureSource({
			projectId: collected.projectId,
			environment: collected.environmentName,
			accessToken: collected.accessToken,
			...(collected.apiBaseUrl === undefined ? {} : { apiBaseUrl: collected.apiBaseUrl }),
		}).catch(() => {
			throw new Error('source configuration did not complete; no credential value is shown. Inspect source and control in Zerops, then run init again')
		})
		log.ok(result.created ? 'source created and configured' : 'source configuration reconciled')
		log.info(
			result.reusedRpcKey ? 'reused the matching source RPC key already held by source and control' : 'generated one source RPC key inside this run',
		)
		if (result.writtenKeys.length > 0) log.ok(`Zerops variables written: ${result.writtenKeys.join(', ')}`)
		const signal = new AbortController().signal
		let mode: Exclude<GitHubAppMode, 'anonymous'> | undefined
		const live = liveGitHubState(result.sourceEnv, result.controlEnv)
		if (Object.keys(live).length === 0 && !(await recoveryLock.hasRecovery())) {
			const modes: Array<{ label: string; value: GitHubAppMode }> = [
				{ label: 'Create an organization-owned GitHub App', value: 'create' },
				{ label: 'Use an existing organization-owned GitHub App', value: 'existing' },
			]
			if (collected.requestedRepositories.length === 0) {
				modes.push({ label: 'Anonymous public repositories only', value: 'anonymous' })
			}
			const selected = await prompts.select<GitHubAppMode>('How should source access GitHub repositories?', modes)
			if (selected === 'anonymous') {
				if (collected.requestedRepositories.length > 0) throw new Error('requested repositories require a GitHub App')
				log.info('source remains in anonymous public-repository mode; no GitHub App or webhook was changed')
				return { continued: true }
			}
			mode = selected
		}
		const installation = await Promise.resolve().then(() => {
			const origin = controlOrigin(collected, result)
			return configureGitHubApp(args.installation, collected, result, origin, recoveryLock, mode, collaborators, signal)
		}).catch(() => {
			throw new Error(
				'GitHub App configuration did not complete; no credential value is shown. Inspect the protected recovery state and Zerops, then run init again',
			)
		})
		return { continued: true, installation }
	})
	if (!sourceStage.continued) return
	if (sourceStage.installation !== undefined) {
		await verifyGitHubInstallation(sourceStage.installation, collaborators, new AbortController().signal).catch(() => {
			throw new Error('GitHub App installation verification did not complete. Inspect the App installation on GitHub, then run init again')
		})
	}

	const dir = await scaffold(args.installation, collected, collaborators)
	if (dir === undefined) {
		return
	}

	log.step(`Configure the ${args.installation} GitHub Environment`)
	const config = environmentConfig(args.installation, collected)
	log.info(`${Object.keys(config.secrets).length} secret(s) and ${Object.keys(config.vars).length} variable(s) on ${collected.repo}.`)
	if (!(await prompts.confirm(`Write them to the ${args.installation} Environment now (secret VALUES go to GitHub over \`gh\` stdin)?`, true))) {
		log.action('OPERATOR ACTION — the pipeline cannot run until the Environment holds these', [
			`fabrika platform init --provider=zerops ${args.installation} --repo=${collected.repo}`,
		])
		return
	}
	await effects.configureEnvironment(config)
	log.ok(`Environment ${args.installation} written: ${Object.keys(config.secrets).join(', ')} and ${Object.keys(config.vars).join(', ')}.`)

	log.step('Trigger the deploy')
	log.info("The pipeline runs the whole ordered sequence in the operator's CI; this machine deploys nothing.")
	if (!(await prompts.confirm(`Run the platform workflow on ${collected.repo} now?`, true))) {
		log.action('OPERATOR ACTION — run it when ready', [
			`gh workflow run platform.yml --repo ${collected.repo}`,
			`or: ${url(`https://github.com/${collected.repo}/actions`)} → platform → Run workflow`,
		])
	} else {
		await effects.triggerWorkflow(collected.repo)
		log.ok('Platform workflow triggered.')
		log.info(`Watch: ${url(`https://github.com/${collected.repo}/actions`)}   (or: gh run watch --repo ${collected.repo})`)
	}

	log.step('Done')
	log.ok(`Sidecar repository: ${collected.repo} (local checkout: ${dir})`)
	log.info('Roll this installation forward by bumping fabrika.ref to a newer published tag and pushing.')
	log.info("Who may administer the installation is IAM's to say: this repository holds no admission list to close later.")
}

/** The real collaborators: a TTY, `gh`, git, and one read of the Zerops API. */
export const consoleInitCollaborators = (): InitCollaborators => ({
	log: {
		step: (title) => consoleStep(title),
		info: (message) => consoleInfo(message),
		warn: (message) => consoleWarn(message),
		ok: (message) => consoleOk(message),
		action: (title, lines) => consoleAction(title, [...lines]),
	},
	prompts: {
		text: (question, fallback) => promptText(question, fallback),
		setting: (variable, question, fallback) => promptText(question, process.env[variable] ?? fallback),
		confirm: (question, defaultYes) => promptConfirm(question, defaultYes),
		select: (question, options) => promptSelect(question, options),
		secret: (variable, question) => secretOrEnv(variable, question),
	},
	effects: {
		repositoryExists: (repo) => ghRepoExists(repo),
		scaffold: (input) => scaffoldSidecarRepository(input),
		configureEnvironment: (config) => configureEnvironment(config),
		triggerWorkflow: (repo) => triggerPlatformWorkflow(repo),
		describeProject: async ({ projectId, accessToken, apiBaseUrl }) => {
			const api = createZeropsApi({ token: accessToken, ...(apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl }) })
			const project = await api.getProject({ projectId, signal: new AbortController().signal })
			if (project.id === '') {
				throw new Error(`Zerops project ${projectId} could not be read with this token`)
			}
			return project.name
		},
		configureSource: async (input) => {
			const api = createZeropsApi({ token: input.accessToken, ...(input.apiBaseUrl === undefined ? {} : { baseUrl: input.apiBaseUrl }) })
			return configureSourceService(input, api, defaultSleep, new AbortController().signal)
		},
		readServiceEnvironment: async ({ serviceId, accessToken, apiBaseUrl }) => {
			const api = createZeropsApi({ token: accessToken, ...(apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl }) })
			return new Map((await api.listServiceEnv({ serviceId, signal: new AbortController().signal })).map((item) => [item.key, item.content]))
		},
		createServiceEnvironment: async ({ serviceId, key, value, accessToken, apiBaseUrl }) => {
			const api = createZeropsApi({ token: accessToken, ...(apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl }) })
			await api.createServiceEnv({ serviceId, key, value, signal: new AbortController().signal })
		},
		sleep: defaultSleep,
		acquireRecovery: (projectId, installation) => acquireGitHubAppRecoveryLock({ projectId, installation }),
		createGitHubApp: (input, onCreated) => createGitHubAppViaManifest(input, { onCreated }),
		createGitHubClient: ({ id, privateKeyPem }) => GitHubAppClient.create({ appId: id, privateKeyPem }),
	},
})
