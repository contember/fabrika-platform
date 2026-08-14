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
// directly to Zerops, never GitHub or disk. GitHub App setup belongs to the authenticated Control UI.

import {
	action as consoleAction,
	configureEnvironment,
	confirm as promptConfirm,
	type EnvironmentConfig,
	ghRepoExists,
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
	decodeZeropsSourceCredentialBundle,
	defaultSleep,
	serializeZeropsSourceCredentialBundle,
	type Sleeper,
	waitForProcess,
	ZEROPS_SOURCE_CREDENTIAL_ENV,
	type ZeropsApi,
	type ZeropsService,
} from '@fabrika/provider-zerops'
import { randomBytes } from 'node:crypto'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '../zerops/generated/platform-proxy-manifest'
import { sourceServiceSpec } from '../zerops/topology'
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

export type ExistingGitHubCredentialState = 'anonymous' | 'adoption-required' | 'conflict'

/** Classify only remote source state. The CLI never materializes or writes a credential. */
export const classifyExistingGitHubCredentials = (sourceEnv: ReadonlyMap<string, string>): ExistingGitHubCredentialState => {
	const durable = sourceEnv.get(ZEROPS_SOURCE_CREDENTIAL_ENV)
	const legacyId = sourceEnv.get('GITHUB_APP_ID')
	const legacyKey = sourceEnv.get('GITHUB_APP_PRIVATE_KEY')
	if (durable === undefined && legacyId === undefined && legacyKey === undefined) return 'anonymous'
	if ((legacyId === undefined) !== (legacyKey === undefined)) return 'conflict'
	let durableBundle: ReturnType<typeof decodeZeropsSourceCredentialBundle> | undefined
	if (durable !== undefined) {
		try {
			durableBundle = decodeZeropsSourceCredentialBundle(durable)
		} catch {
			return 'conflict'
		}
	}
	if (legacyId !== undefined && legacyKey !== undefined) {
		let legacy: string
		try {
			legacy = serializeZeropsSourceCredentialBundle({ version: 1, githubAppId: legacyId, privateKeyPem: legacyKey })
		} catch {
			return 'conflict'
		}
		if (durable !== undefined && legacy !== durable) return 'conflict'
	}
	return durableBundle === undefined && legacyId === undefined ? 'anonymous' : 'adoption-required'
}

const strictHttpsOrigin = (hostValue: string): string | undefined => {
	const host = hostValue.trim().toLowerCase()
	const labels = host.split('.')
	if (
		host === '' || host.length > 253 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	) {
		return undefined
	}
	try {
		const parsed = new URL(`https://${host}`)
		if (parsed.origin !== `https://${host}` || parsed.hostname !== host || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') {
			return undefined
		}
		return parsed.origin
	} catch {
		return undefined
	}
}

/** Return a verified live console URL, or no URL when init would have to guess. */
export const sourceConnectionSettingsUrl = (placement: Placement, source: ConfigureSourceResult): string | undefined => {
	const liveHost = source.controlEnv.get('FABRIKA_CONTROL_DOMAIN')
	if (liveHost === undefined) return undefined
	const origin = strictHttpsOrigin(liveHost)
	if (origin === undefined) return undefined
	const host = new URL(origin).hostname
	if (placement.hosts !== undefined) {
		if (placement.hosts.control.toLowerCase() !== host) return undefined
		return `${origin}/settings/source`
	}
	if (!source.proxyPublished) return undefined
	const subdomains = source.proxyEnv.get(ZEROPS_SUBDOMAIN_VARIABLE)
	if (subdomains === undefined || subdomains.trim() === '') return undefined
	try {
		const listeners = PLATFORM_PROXY_MANIFEST_TEMPLATE.apps.map((app) => ({ service: app.service, port: app.port }))
		if (derivePlatformHosts(subdomains, listeners).control.toLowerCase() !== host) return undefined
		return `${origin}/settings/source`
	} catch {
		return undefined
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
	log.step('Configure the private source service')
	log.info('This repairs only source transport and project binding. GitHub App setup belongs to the authenticated Control UI.')
	if (!(await prompts.confirm(`Create or configure \`source\` in Zerops project ${collected.projectId}?`, true))) {
		log.action('OPERATOR ACTION — source was not changed; run init again to continue', [
			`fabrika platform init --provider=zerops ${args.installation} --repo=${collected.repo}`,
		])
		return
	}
	const source = await effects.configureSource({
		projectId: collected.projectId,
		environment: collected.environmentName,
		accessToken: collected.accessToken,
		...(collected.apiBaseUrl === undefined ? {} : { apiBaseUrl: collected.apiBaseUrl }),
	}).catch(() => {
		throw new Error('source configuration did not complete; no credential value is shown. Inspect source and control in Zerops, then run init again')
	})
	log.ok(source.created ? 'source created and configured' : 'source configuration reconciled')
	log.info(
		source.reusedRpcKey ? 'reused the matching source RPC key already held by source and control' : 'generated one source RPC key inside this run',
	)
	if (source.writtenKeys.length > 0) log.ok(`Zerops variables written: ${source.writtenKeys.join(', ')}`)
	const credentialState = classifyExistingGitHubCredentials(source.sourceEnv)
	if (credentialState === 'conflict') {
		throw new Error('source holds partial, invalid, or mismatched GitHub App credentials; no value was changed')
	}
	const settingsUrl = sourceConnectionSettingsUrl(collected.placement, source)
	if (credentialState === 'adoption-required') {
		log.info('source already holds a complete GitHub App credential set. Control must adopt it before private source is connected.')
	} else {
		log.info('source remains in anonymous public-repository mode. Connect private GitHub source later in Control.')
	}
	log.action(
		credentialState === 'adoption-required'
			? 'OPERATOR ACTION — adopt the existing GitHub App in Control'
			: 'OPERATOR ACTION — connect GitHub source in Control',
		settingsUrl === undefined
			? ['Deploy the platform, then open Settings → Source in the authenticated Control console. No unverified URL was guessed.']
			: [url(settingsUrl)],
	)

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
	},
})
