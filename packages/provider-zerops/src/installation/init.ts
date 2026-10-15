// `fabrika platform init --provider=zerops <installation>` — maintain the operator's sidecar repository
// for an installation that ALREADY EXISTS.
//
// ── What this does, and the one thing it does not ─────────────────────────────────────────────────
//
// It reads the installation's `control` and `proxy` configuration, creates
// `<owner>/fabrika-zerops-<installation>`, pushes the pipeline that calls
// `fabrika platform deploy --provider=zerops`, writes the GitHub Environment that pipeline reads, and
// triggers it. It does NOT create the installation: `platform install` owns the first bring-up.
//
// ── It does the whole job, and confirms before every step that leaves this disk ───────────────────
//
// Reading the project, reading its services, creating or pushing the repository, writing the Environment,
// and triggering the workflow each ask first. Full automation, never silent. Declining a write stops the outward steps and prints
// what to run instead; `init` is idempotent, so the answer to a declined step is to run it again. Declining the read of
// `control` and `proxy` only leaves the console and IAM origins out of what init prints.
//
// ── Credentials ───────────────────────────────────────────────────────────────────────────────────
//
// Two deployment credentials, and this command generates neither. Both already belong to the
// installation. It writes nothing to Zerops. GitHub App setup belongs to the authenticated Control UI.

import {
	action as consoleAction,
	configureEnvironment,
	type Confirmations,
	confirmations,
	type EnvironmentConfig,
	ghRepoExists,
	info as consoleInfo,
	ok as consoleOk,
	scaffoldSidecarRepository,
	shellWord,
	type SidecarScaffoldInput,
	type SidecarScaffoldResult,
	step as consoleStep,
	triggerPlatformWorkflow,
	url,
	warn as consoleWarn,
} from '@fabrika/installation-init'
import { createZeropsApi, type ZeropsApi, type ZeropsService } from '../index'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from './generated/platform-proxy-manifest'
import { derivePlatformHosts, ZEROPS_SUBDOMAIN_VARIABLE } from './hosts'
import type { InitInput } from './init-options'
import type { InitLog } from './log'
import { MACHINE_KEY_NEXT_STEP_TITLE, machineKeyNextStepLines } from './machine-key'
import { materializeSidecarScaffold, readPinnedTag, SIDECAR_FILES } from './sidecar'

/** Everything `runInit` does outside the operator's own disk. Every one of them is confirmed first. */
export interface InitEffects {
	/** Only decides how the scaffold confirmation is phrased; the scaffold itself re-reads it. */
	repositoryExists(repo: string): Promise<boolean>
	scaffold(input: SidecarScaffoldInput): Promise<SidecarScaffoldResult>
	configureEnvironment(config: EnvironmentConfig): Promise<void>
	triggerWorkflow(repo: string): Promise<void>
	/** Read one Zerops project's name — the cheapest proof that the token and the project id agree. */
	describeProject(input: { projectId: string; accessToken: string; apiBaseUrl?: string }): Promise<string>
	inspectPlatform(input: InspectPlatformInput): Promise<PlatformInspection>
}

export interface InitCollaborators {
	readonly log: InitLog
	readonly prompts: Confirmations
	readonly effects: InitEffects
}

/** Where this installation answers, as far as `init` needs to know it. */
interface Placement {
	readonly hosts?: { readonly iam: string; readonly control: string; readonly operations: string }
}

export interface InspectPlatformInput {
	readonly projectId: string
	readonly accessToken: string
	readonly apiBaseUrl?: string
}

/** What `init` reads off the live installation to print origins it can verify. Values are never logged. */
export interface PlatformInspection {
	readonly controlEnv: ReadonlyMap<string, string>
	readonly proxyEnv: ReadonlyMap<string, string>
	readonly proxyPublished: boolean
}

const oneService = (services: readonly ZeropsService[], name: string): ZeropsService | undefined => {
	const matches = services.filter((service) => service.name === name)
	if (matches.length > 1) throw new Error(`Zerops project has ${matches.length} services named \`${name}\``)
	return matches[0]
}

/** Read `control` and `proxy` without writing anything. */
export const inspectPlatform = async (projectId: string, api: ZeropsApi, signal: AbortSignal): Promise<PlatformInspection> => {
	const services = await api.listProjectServices({ projectId, signal })
	const control = oneService(services, 'control')
	if (control === undefined || control.id === '') throw new Error(`Zerops project ${projectId} has no \`control\` service`)
	const proxy = oneService(services, 'proxy')
	if (proxy === undefined || proxy.id === '') throw new Error(`Zerops project ${projectId} has no \`proxy\` service`)
	// Only the readable values: everything init prints is derived from non-secret configuration.
	const readEnv = async (serviceId: string): Promise<Map<string, string>> => {
		const readable = new Map<string, string>()
		for (const item of await api.listServiceEnv({ serviceId, signal })) {
			if (!item.sensitive) readable.set(item.key, item.content)
		}
		return readable
	}
	return {
		controlEnv: await readEnv(control.id),
		proxyEnv: await readEnv(proxy.id),
		proxyPublished: proxy.subdomainAccess === true,
	}
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

/**
 * IAM's PUBLIC origin as the installation itself records it, or nothing when init would have to guess.
 *
 * `platform install` writes it to `control` as `FABRIKA_IAM_ISSUER`, so this reads the live value
 * rather than re-deriving one — and refuses it when the operator named a different IAM host, because
 * a printed origin an operator then pastes into `FABRIKA_IAM_RPC_URL` must be the one that answers.
 */
export const platformIamOrigin = (placement: Placement, platform: PlatformInspection): string | undefined => {
	const issuer = platform.controlEnv.get('FABRIKA_IAM_ISSUER')
	if (issuer === undefined) return undefined
	let hostname: string
	try {
		const parsed = new URL(issuer.trim())
		if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return undefined
		if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return undefined
		hostname = parsed.hostname
	} catch {
		return undefined
	}
	const origin = strictHttpsOrigin(hostname)
	if (origin === undefined) return undefined
	if (placement.hosts !== undefined && placement.hosts.iam.trim().toLowerCase() !== hostname) return undefined
	return origin
}

/** Return a verified live console URL, or no URL when init would have to guess. */
export const sourceConnectionSettingsUrl = (placement: Placement, platform: PlatformInspection): string | undefined => {
	const liveHost = platform.controlEnv.get('FABRIKA_CONTROL_DOMAIN')
	if (liveHost === undefined) return undefined
	const origin = strictHttpsOrigin(liveHost)
	if (origin === undefined) return undefined
	const host = new URL(origin).hostname
	if (placement.hosts !== undefined) {
		if (placement.hosts.control.toLowerCase() !== host) return undefined
		return `${origin}/settings/source`
	}
	if (!platform.proxyPublished) return undefined
	const subdomains = platform.proxyEnv.get(ZEROPS_SUBDOMAIN_VARIABLE)
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
const environmentConfig = (installation: string, input: InitInput): EnvironmentConfig => ({
	repo: input.repo,
	environment: installation,
	secrets: {
		FABRIKA_ZEROPS_ACCESS_TOKEN: input.accessToken,
		FABRIKA_IAM_PROVISIONING_KEY: input.provisioningKey,
	},
	vars: {
		FABRIKA_ZEROPS_PROJECT_ID: input.projectId,
		FABRIKA_PLATFORM_ENVIRONMENT: input.environmentName,
		// Stated rather than defaulted, so the Environment describes the whole deploy.
		FABRIKA_PLATFORM_SCHEME: 'https',
		...(input.hosts === undefined ? {} : {
			FABRIKA_PLATFORM_IAM_HOST: input.hosts.iam,
			FABRIKA_PLATFORM_CONSOLE_HOST: input.hosts.control,
			FABRIKA_PLATFORM_OPERATIONS_HOST: input.hosts.operations,
		}),
		...(input.apiBaseUrl === undefined ? {} : { FABRIKA_ZEROPS_API_URL: input.apiBaseUrl }),
	},
})

/** The command that repeats this run, with every value but the two credentials, which stay in the environment. */
const rerunCommand = (input: InitInput): string =>
	[
		'fabrika platform init --provider=zerops',
		...[
			input.installation,
			`--repo=${input.repo}`,
			`--checkout=${input.checkoutDir}`,
			`--tag=${input.fabrikaRef}`,
			`--project-id=${input.projectId}`,
			`--env=${input.environmentName}`,
			...(input.hosts === undefined
				? []
				: [`--iam-host=${input.hosts.iam}`, `--console-host=${input.hosts.control}`, `--operations-host=${input.hosts.operations}`]),
		].map(shellWord),
	].join(' ')

/** Read the project back, so a wrong token or a mistyped id fails here rather than in someone's CI. */
const verifyProject = async (input: InitInput, { log, prompts, effects }: InitCollaborators): Promise<void> => {
	log.step('Check the token against the project')
	if (!(await prompts.confirm(`Read Zerops project ${input.projectId} to check the access token and the id?`, true))) {
		log.info('Skipped. A wrong token or project id will surface in the first pipeline run instead.')
		return
	}
	// A caught error is never re-thrown as itself: it may quote a request URL or a platform payload, and
	// this is the one step holding both credentials. A short sentence naming the two causes is enough.
	const name = await effects.describeProject({
		projectId: input.projectId,
		accessToken: input.accessToken,
		...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl }),
	}).catch(() => {
		throw new Error(
			`Zerops project ${input.projectId} could not be read: the access token does not grant it, or the id is wrong. `
				+ 'Nothing has been created — check both and run init again',
		)
	})
	log.ok(`Zerops project ${name} (${input.projectId}) is readable with this token.`)
}

/**
 * Read the live `control` and `proxy` configuration, so the origins init prints are ones the installation records.
 *
 * Declining is not fatal: init then prints no origin rather than one it would have to guess.
 */
const readPlatform = async (input: InitInput, { log, prompts, effects }: InitCollaborators): Promise<PlatformInspection | undefined> => {
	log.step('Read the installation')
	if (!(await prompts.confirm(`Read \`control\` and \`proxy\` in Zerops project ${input.projectId} for the console and IAM origins?`, true))) {
		log.info('Skipped. No console or IAM origin will be printed.')
		return undefined
	}
	return effects.inspectPlatform({
		projectId: input.projectId,
		accessToken: input.accessToken,
		...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl }),
	}).catch(() => {
		throw new Error('the `control` and `proxy` services could not be read; no credential value is shown. Inspect them in Zerops, then run init again')
	})
}

/** The local checkout and the tag its `fabrika.ref` pins, which an existing sidecar keeps whatever `--tag` says. */
interface ScaffoldedSidecar {
	readonly dir: string
	readonly pinned: string
}

/**
 * Create or refresh the sidecar repository — the first step that leaves this disk.
 *
 * Returns the local checkout, or `undefined` when the operator declined, which stops every later
 * outward step: an Environment cannot be written to a repository that does not exist, and a workflow
 * cannot be triggered without one.
 */
const scaffold = async (input: InitInput, { log, prompts, effects }: InitCollaborators): Promise<ScaffoldedSidecar | undefined> => {
	log.step('Scaffold the sidecar repository')
	const exists = await effects.repositoryExists(input.repo)
	const question = exists
		? `Refresh the pipeline on ${input.repo} and push?`
		: `Create ${input.repo} (private) on GitHub and push the pipeline?`
	if (!(await prompts.confirm(question, true))) {
		log.action('OPERATOR ACTION — nothing was created; run init again when ready', [
			rerunCommand(input),
		])
		return undefined
	}
	const result = await effects.scaffold({
		repo: input.repo,
		dir: input.checkoutDir,
		files: [...SIDECAR_FILES],
		materialize: (target) =>
			materializeSidecarScaffold(target, {
				installation: input.installation,
				repo: input.repo,
				fabrikaRef: input.fabrikaRef,
			}),
	})
	const pinned = await readPinnedTag(result.dir)
	log.ok(`${input.repo} ${result.created ? 'created' : 'refreshed'} — pinned fabrika tag ${pinned}`)
	if (pinned !== input.fabrikaRef) {
		log.warn(`the existing pin ${pinned} was kept; ${input.fabrikaRef} was not written, because fabrika.ref is operator-owned`)
	}
	return { dir: result.dir, pinned }
}

/**
 * Refuse to trigger a run that would deploy a tag other than `--tag`: the run deploys the kept pin, so a sidecar reused
 * for a new installation would roll an older release over it. The Environment is already written, so the pin moves by
 * `upgrade`, whose push triggers the run with it.
 */
const assertPinnedAsRequested = (input: InitInput, sidecar: ScaffoldedSidecar): void => {
	if (sidecar.pinned === input.fabrikaRef) return
	throw new Error(
		`the platform workflow was NOT triggered: ${input.repo} pins ${sidecar.pinned}, not ${input.fabrikaRef}, and a run deploys the pin. `
			+ `The ${input.installation} Environment is written. To deploy ${input.fabrikaRef}, move the pin: `
			+ `fabrika platform upgrade --provider=zerops --to=${input.fabrikaRef} --sidecar=${sidecar.dir}. `
			+ `To deploy ${sidecar.pinned}, run init again with --tag=${sidecar.pinned}`,
	)
}

/** Run the whole thing for `<installation>`. */
export const runInit = async (input: InitInput, collaborators: InitCollaborators): Promise<void> => {
	const { log, prompts, effects } = collaborators
	log.info(`fabrika platform init — the ${input.installation} Zerops installation's sidecar repository`)
	log.info('This UPDATES an installation that already exists. It does not create one.')

	log.step('The installation this repository will deploy')
	log.info(`repository ${input.repo}, pinned to ${input.fabrikaRef}; Zerops project ${input.projectId}, environment \`${input.environmentName}\``)
	log.info(
		input.hosts === undefined
			? "hosts: derived from the proxy's Zerops subdomains"
			: `hosts: iam ${input.hosts.iam}, console ${input.hosts.control}, operations ${input.hosts.operations}`,
	)
	await verifyProject(input, collaborators)
	const platform = await readPlatform(input, collaborators)
	const settingsUrl = platform === undefined ? undefined : sourceConnectionSettingsUrl(input, platform)
	log.info('Public repositories deploy without a GitHub App. Connect private GitHub source in Control.')
	log.action(
		'OPERATOR ACTION — connect GitHub source in Control',
		settingsUrl === undefined
			? ['Deploy the platform, then open Settings → Source in the authenticated Control console. No unverified URL was guessed.']
			: [url(settingsUrl)],
	)

	const sidecar = await scaffold(input, collaborators)
	if (sidecar === undefined) {
		return
	}

	log.step(`Configure the ${input.installation} GitHub Environment`)
	const config = environmentConfig(input.installation, input)
	log.info(`${Object.keys(config.secrets).length} secret(s) and ${Object.keys(config.vars).length} variable(s) on ${input.repo}.`)
	if (!(await prompts.confirm(`Write them to the ${input.installation} Environment now (secret VALUES go to GitHub over \`gh\` stdin)?`, true))) {
		log.action('OPERATOR ACTION — the pipeline cannot run until the Environment holds these', [
			rerunCommand(input),
		])
		return
	}
	await effects.configureEnvironment(config)
	log.ok(`Environment ${input.installation} written: ${Object.keys(config.secrets).join(', ')} and ${Object.keys(config.vars).join(', ')}.`)

	log.step('Trigger the deploy')
	assertPinnedAsRequested(input, sidecar)
	log.info("The pipeline runs the whole ordered sequence in the operator's CI; this machine deploys nothing.")
	if (!(await prompts.confirm(`Run the platform workflow on ${input.repo} now?`, true))) {
		log.action('OPERATOR ACTION — run it when ready', [
			`gh workflow run platform.yml --repo ${input.repo}`,
			`or: ${url(`https://github.com/${input.repo}/actions`)} → platform → Run workflow`,
		])
	} else {
		await effects.triggerWorkflow(input.repo)
		log.ok('Platform workflow triggered.')
		log.info(`Watch: ${url(`https://github.com/${input.repo}/actions`)}   (or: gh run watch --repo ${input.repo})`)
	}

	log.step('Done')
	log.ok(`Sidecar repository: ${input.repo} (local checkout: ${sidecar.dir})`)
	log.info('Roll this installation forward by bumping fabrika.ref to a newer published tag and pushing.')
	log.info("Who may administer the installation is IAM's to say: this repository holds no admission list to close later.")
	// The origin comes off the live control service, never from what was typed here: an operator who
	// pastes a guessed hostname into FABRIKA_IAM_RPC_URL gets "Unable to connect" and no explanation.
	const iamOrigin = platform === undefined ? undefined : platformIamOrigin(input, platform)
	log.action(
		MACHINE_KEY_NEXT_STEP_TITLE,
		machineKeyNextStepLines({ sidecarEnvironment: input.installation, ...(iamOrigin === undefined ? {} : { iamOrigin }) }),
	)
}

/** The real collaborators: a TTY, `gh`, git, and one read of the Zerops API. */
export const consoleInitCollaborators = (input: InitInput): InitCollaborators => ({
	log: {
		step: (title) => consoleStep(title),
		info: (message) => consoleInfo(message),
		warn: (message) => consoleWarn(message),
		ok: (message) => consoleOk(message),
		action: (title, lines) => consoleAction(title, [...lines]),
	},
	// First, before anything is contacted: a run nobody can confirm does not start.
	prompts: confirmations(
		input.unattended,
		process.stdin,
		(line) => consoleInfo(line),
		'creates or pushes the sidecar repository, writes its GitHub Environment secrets and triggers the platform workflow',
	),
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
		inspectPlatform: async (input) => {
			const api = createZeropsApi({ token: input.accessToken, ...(input.apiBaseUrl === undefined ? {} : { baseUrl: input.apiBaseUrl }) })
			return inspectPlatform(input.projectId, api, new AbortController().signal)
		},
	},
})
