// Public hosts exist only after the proxy deploys HTTP ports. Pass 1 builds an empty-manifest proxy;
// pass 2 writes the full environment and delegates the ordered deploy to `deployPlatform` (ADR-0027).
// This is bring-up only: existing generated-secret keys and partial topologies are refused.

import {
	action as consoleAction,
	confirmations,
	info as consoleInfo,
	ok as consoleOk,
	step as consoleStep,
	warn as consoleWarn,
} from '@fabrika/installation-init'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import { createZeropsApi, defaultSleep, type ZeropsNamespaceProxySource } from '../index'
import {
	deployPlatformService,
	deployPreparedPlatform,
	PLATFORM_CONCURRENT_DEPLOY,
	PLATFORM_DEPLOY_ORDER,
	PLATFORM_PROXY_SERVICE,
	PLATFORM_SEQUENTIAL_DEPLOY,
	readServiceEnv,
	type ResolvedService,
} from './deploy'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from './generated/platform-proxy-manifest'
import { derivePlatformHosts, type PlatformHosts, platformOrigin, ZEROPS_SUBDOMAIN_VARIABLE } from './hosts'
import { checkedEnvironmentName } from './init-options'
import { assertRunning, type InstallCollaborators, type InstallPrompts } from './install-collaborators'
import { installationServiceEnv, passOneProxyEnv, writeServiceEnv } from './install-environment'
import type { PlatformInstallInput } from './install-options'
import { resolveInstallationProject } from './install-project'
import {
	assertNoServiceIsBeingCreated,
	assertNotAlreadyInstalled,
	existingServices,
	provision,
	provisioningDocument,
	resolvePlatformServices,
	serviceOf,
} from './install-provisioning'
import { explainMintFailure } from './install-token'
import { prepareInstallationSource, prepareNamespaceProxySource, validateInstallationSetups } from './installation-source'
import type { PreparedPlatformSource } from './platform-source'
import { generateInstallationSecrets, type InstallationSecrets } from './secrets'

export type { InstallCollaborators, InstallPrompts } from './install-collaborators'
export { GENERATED_SECRET_KEYS, type InstallationEnvInput, installationServiceEnv } from './install-environment'

/**
 * Pass 1 — give the proxy its ports, so the installation has public hostnames.
 *
 * Returns the three derived hosts. `derivePlatformHosts` refuses to compose a hostname, so a proxy that
 * did not publish its six listeners fails here rather than producing a manifest pointing at an address
 * nobody answers.
 */
const passOne = async (
	source: PreparedPlatformSource,
	proxy: ResolvedService,
	secrets: InstallationSecrets,
	collaborators: InstallCollaborators,
): Promise<PlatformHosts> => {
	const { log, prompts } = collaborators
	log.step('Pass 1 — build the proxy so the installation has public hostnames')
	log.info('An empty manifest is a legal one: the proxy comes up answering 404 and publishes one hostname per HTTP port.')
	if (!(await prompts.confirm(`Write 4 variables on \`proxy\` and build commit ${source.commitSha}? (about 4 minutes)`, true))) {
		throw new Error('declined: no variable was written, and re-running the install is safe')
	}
	await writeServiceEnv(proxy, passOneProxyEnv(secrets), collaborators)
	await deployPlatformService(proxy, { source, dryRun: false }, collaborators)

	const proxyEnv = await readServiceEnv(proxy.id, collaborators)
	const subdomains = proxyEnv.get(ZEROPS_SUBDOMAIN_VARIABLE)
	if (subdomains === undefined || subdomains.trim() === '') {
		throw new Error('the proxy published no Zerops subdomain after its first deploy — this installation has no address to be named by')
	}
	const listeners = PLATFORM_PROXY_MANIFEST_TEMPLATE.apps.map((app) => ({ service: app.service, port: app.port }))
	return derivePlatformHosts(subdomains, listeners)
}

/**
 * Bring up one Zerops platform installation, in a project the operator created empty or in one created
 * here.
 *
 * Every step that leaves this machine is confirmed first, and declining any of them stops there with
 * what to run instead. Nothing after the project step and before the import is a mutation, so a declined
 * install leaves the project exactly as it was.
 */
export const runInstall = async (input: PlatformInstallInput, collaborators: InstallCollaborators): Promise<void> => {
	const source = await collaborators.prepareSource(input.sourceDir, collaborators.signal)
	try {
		validateInstallationSetups(source, PLATFORM_DEPLOY_ORDER)
		const proxySource = await prepareNamespaceProxySource(source)
		await installPreparedPlatform(input, collaborators, source, proxySource)
	} finally {
		await source.dispose()
	}
}

const installPreparedPlatform = async (
	input: PlatformInstallInput,
	collaborators: InstallCollaborators,
	source: PreparedPlatformSource,
	proxySource: ZeropsNamespaceProxySource,
): Promise<void> => {
	const { log, prompts, signal } = collaborators
	assertRunning(signal)
	// Refused HERE, before anything is contacted: `local` is the name every development bypass is gated
	// on, and IAM and control both refuse to boot with it on a public origin.
	const environment = checkedEnvironmentName(input.environment)

	log.info(`fabrika platform install — the ${environment} Zerops installation, on the ${input.tier} tier`)
	log.info('This CREATES an installation. It generates every credential it needs and prints one of them at the end.')

	const project = await resolveInstallationProject(input, environment, collaborators)
	log.ok(`project ${project.name} (${project.id})`)

	log.step('Provision the topology')
	const document = provisioningDocument(environment)
	const declared = document.document.services.map((service) => service.hostname)
	const existing = existingServices(declared, await collaborators.api.listProjectServices({ projectId: project.id, signal }))
	assertNoServiceIsBeingCreated(existing)
	await assertNotAlreadyInstalled(existing, collaborators)
	await provision(project.id, document, existing, collaborators)
	const services = await resolvePlatformServices(project.id, collaborators)

	log.step("Generate this installation's secrets")
	const secrets = generateInstallationSecrets()
	log.ok(
		'IAM signing keys (1 × ES256), the IAM RPC key, the proxy key, the provisioning key, the Operations sync key and the vault key',
	)
	log.info('None of them is written to disk. Only the provisioning key is printed, once, at the end.')

	log.step("Mint the control plane's Zerops token")
	log.info('An INTEGRATION token, client role NO_ACCESS with ADMIN on this one project — never the personal token you authenticated with.')
	if (!(await prompts.confirm(`Mint an integration token named \`fabrika-${environment}\` on client ${input.clientId}?`, true))) {
		throw new Error('declined: nothing was minted, and re-running the install is safe')
	}
	const token = await collaborators.api.createIntegrationToken({
		clientId: input.clientId,
		name: `fabrika-${environment}`,
		projects: [{ projectId: project.id, roleCode: 'ADMIN' }],
		roleCode: 'NO_ACCESS',
		// An app namespace IS a project, so a control plane that cannot create one cannot deploy an
		// application at all (ADR-0034). `NO_ACCESS` still keeps every project it did not create out of reach.
		canCreateProjects: true,
		signal,
	}).catch((failure: unknown) => {
		throw explainMintFailure(failure, project.id)
	})
	if (token.token === '') {
		throw new Error('Zerops minted an integration token with no value — the control plane cannot deploy anything without one')
	}
	log.ok(`integration token ${token.id} minted, ${token.projects.length} project grant(s)`)

	const hosts = await passOne(source, serviceOf(services, PLATFORM_PROXY_SERVICE), secrets, collaborators)
	log.ok(`iam ${hosts.iam}`)
	log.ok(`console ${hosts.control}`)
	log.ok(`operations ${hosts.operations}`)

	log.step('Write every remaining variable')
	const desired = installationServiceEnv({
		environment,
		scheme: input.scheme,
		hosts,
		clientId: input.clientId,
		proxySource,
		secrets,
		zeropsAccessToken: token.token,
		...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl }),
	})
	const total = [...desired.values()].reduce((sum, keys) => sum + keys.size, 0)
	if (!(await prompts.confirm(`Write ${total} variables across ${desired.size} services?`, true))) {
		throw new Error(
			'declined: the proxy is built but the installation is not configured. Its generated proxy key is already placed, so '
				+ 're-running `platform install` is refused. Neither `platform deploy` nor `platform init` completes a partial bootstrap. '
				+ 'Preserve the existing keys and arrange operator-owned recovery, or start a fresh installation in a separate empty project',
		)
	}
	for (const hostname of PLATFORM_DEPLOY_ORDER) {
		await writeServiceEnv(serviceOf(services, hostname), desired.get(hostname) ?? new Map<string, string>(), collaborators)
	}

	log.step('Pass 2 — deploy the installation')
	log.info(
		'Every bootstrap variable is placed. If this deploy fails, read FABRIKA_IAM_PROVISIONING_KEY from `iam` or `control` '
			+ 'and FABRIKA_ZEROPS_ACCESS_TOKEN from `control` in Zerops, then run `fabrika platform deploy --provider=zerops` with this project and source checkout.',
	)
	log.info(
		`\`platform deploy\` owns the whole ordered sequence: ${PLATFORM_CONCURRENT_DEPLOY.join(' + ')} together, then ${
			PLATFORM_SEQUENTIAL_DEPLOY.join(' → ')
		} — the proxy ahead of control (ADR-0027).`,
	)
	if (!(await prompts.confirm('Deploy the installation now? (about 15 minutes)', true))) {
		log.action('OPERATOR ACTION — every variable is placed; the installation is one command from running', [
			`FABRIKA_ZEROPS_ACCESS_TOKEN=… FABRIKA_IAM_PROVISIONING_KEY=… fabrika platform deploy --provider=zerops --source-dir=. --project-id=${project.id} --env=${environment}`,
		])
	} else {
		await deployPreparedPlatform(
			{
				project: { kind: 'id', projectId: project.id },
				accessToken: input.accessToken,
				environment,
				scheme: input.scheme,
				sourceDir: input.sourceDir,
				iamAdminKey: secrets.provisioningKey,
				dryRun: false,
				...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl }),
			},
			collaborators,
			source,
		)
	}

	log.step('Hand off')
	// The intentional secret-output exception: init needs the key IAM was seeded with, never a new value.
	log.action('CAPTURE THIS NOW — the CLI keeps no copy; recover it from the `iam` or `control` service environment in Zerops', [
		`FABRIKA_IAM_PROVISIONING_KEY=${secrets.provisioningKey}`,
	])
	log.info('`fabrika platform init --provider=zerops <installation>` asks for two required deployment secrets:')
	log.info('  FABRIKA_IAM_PROVISIONING_KEY   the key above')
	log.info('  FABRIKA_ZEROPS_ACCESS_TOKEN    the integration token just minted — read it back from the `control` service, never printed here')
	log.info(`The console answers at ${platformOrigin(input.scheme, hosts.control)}, once someone can sign in: nobody can yet.`)
	// Through the SAME boxed path as the key above, deliberately: `action` is already the one output
	// that carries a secret value, so the ready-to-run command does not become a second place one is
	// printed. `platform admin` is idempotent, so re-running it is safe.
	log.action('ADMIT YOURSELF — the console has no administrator until this runs', [
		`FABRIKA_IAM_PROVISIONING_KEY=${secrets.provisioningKey} fabrika platform admin --provider=zerops --email=<you> --iam-host=${hosts.iam}`,
	])
}

/**
 * The confirmations stand between a stray invocation and an installation: this command generates six
 * credentials, mints a Zerops token on the account and deploys.
 */
export const installPrompts = (
	input: PlatformInstallInput,
	stdin: { readonly isTTY?: boolean },
	announce: (line: string) => void,
): InstallPrompts =>
	confirmations(input.unattended, stdin, announce, "generates this installation's credentials, mints a Zerops integration token and deploys")

/** The real collaborators: a TTY for the confirmations, the Zerops API, and IAM's own schema reconciler. */
export const consoleInstallCollaborators = (input: PlatformInstallInput, reconcileSchema: SchemaReconciler): InstallCollaborators => {
	// First, before anything is built or contacted: a bring-up nobody can confirm does not start.
	const prompts = installPrompts(input, process.stdin, (line) => consoleInfo(line))
	return {
		prepareSource: prepareInstallationSource,
		uploadFetch: (url, init) => fetch(url, init),
		api: createZeropsApi({
			token: input.accessToken,
			...(input.apiBaseUrl === undefined ? {} : { baseUrl: input.apiBaseUrl }),
		}),
		reconcileSchema,
		sleep: defaultSleep,
		log: {
			step: (title) => consoleStep(title),
			info: (message) => consoleInfo(message),
			warn: (message) => consoleWarn(message),
			ok: (message) => consoleOk(message),
			action: (title, lines) => consoleAction(title, [...lines]),
		},
		prompts,
		signal: new AbortController().signal,
	}
}
