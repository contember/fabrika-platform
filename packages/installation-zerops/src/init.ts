// `fabrika platform init --provider=zerops <installation>` — create and maintain the operator's sidecar
// repository for an installation that ALREADY EXISTS.
//
// ── What this does, and the one thing it does not ─────────────────────────────────────────────────
//
// It creates `<owner>/fabrika-zerops-<installation>`, pushes the pipeline that calls
// `fabrika platform deploy --provider=zerops`, writes the GitHub Environment that pipeline reads, and
// triggers it. It does NOT bring an installation up: the first bring-up (import the topology without
// code → write every secret → deploy once so the proxy has HTTP ports and therefore a public address)
// is still a hand sequence, because a proxy that has never been deployed publishes no hostname while
// the manifest must be written before the proxy is built.
//
// ── It does the whole job, and confirms before every step that leaves this disk ───────────────────
//
// Creating the repository, pushing it, writing the Environment, triggering the workflow — each asks
// first. Full automation, never silent. Declining stops the outward steps and prints what to run
// instead; `init` is idempotent, so the answer to a declined step is to run it again.
//
// ── Credentials ───────────────────────────────────────────────────────────────────────────────────
//
// Two, and this command GENERATES NEITHER. Both already belong to the installation — the Zerops access
// token is the operator's, and the IAM provisioning key is the one IAM was seeded with at bring-up, so
// a value invented here would simply not be the value IAM admits. They are read from a hidden prompt or
// from the environment, sent to GitHub over `gh` stdin, and never written to disk and never logged.
// Unlike the Cloudflare init there is no `.env` resume, deliberately: this flow is short enough to
// repeat, and the alternative is a Zerops account token sitting in a plaintext file.

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
import { createZeropsApi } from '@fabrika/provider-zerops'
import { FABRIKA_REPOSITORY_URL } from './install-options'
import type { InitLog } from './log'
import { assertPinnedTag, defaultCheckoutDir, defaultSidecarRepo, materializeSidecarScaffold, readPinnedTag, SIDECAR_FILES } from './sidecar'

/** The name every bypass in this platform is gated on, and therefore the one name an installation cannot take. */
const LOCAL_ENVIRONMENT = 'local'

/** Everything `runInit` asks the operator. Injected so the flow can be exercised without a TTY. */
export interface InitPrompts {
	text(question: string, fallback?: string): Promise<string>
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
	},
})
