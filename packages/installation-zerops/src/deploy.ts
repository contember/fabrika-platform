// `fabrika platform deploy --provider=zerops` — the WHOLE ordered sequence, in code.
//
// [ADR-0027](../../../docs/decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md) decided
// that on Zerops this command owns the order rather than the operator's pipeline, and gave two reasons
// that both live here:
//
//   • The proxy manifest is CROSS-SERVICE state that must move with the code it describes. No single
//     pipeline step owns a document spanning every service the pipeline deploys.
//   • **The order carries a security property.** Since ADR-0022 the application enforces nothing, so
//     deploying control at a new version while the previous, more permissive manifest is still in
//     front of it leaves `/api/*` open for the length of the deploy. The order is therefore
//     IAM → Operations → source → **proxy** → control: the dependency order, with the enforcement point moved
//     ahead of the service whose gates just widened. `__tests__/deploy.test.ts` pins it.
//
// Bringing `fabrika-test` to HEAD on 2026-08-05 took `zops push` from a laptop, once per service, in a
// hand-chosen order, and everything that made that run correct stayed in a run log. This file is that
// run log, executable.
//
// ── What this command writes, and what it deliberately does not ───────────────────────────────────
//
// It writes exactly two kinds of value: the composed proxy manifest, and the per-installation
// configuration derived from the resolved public hosts (each service's own origin, the origins it must
// know about, and the installation's environment name). **It writes no credential at all** — every
// secret an installation holds is `platform init`'s to place, and a deploy that cannot write one cannot
// leak one. The two credentials this command HOLDS are the Zerops access token and the IAM admin key,
// both from the environment, neither ever logged.
//
// ── Idempotence ───────────────────────────────────────────────────────────────────────────────────
//
// Every variable is READ before it is written and skipped when it already matches, so a second run
// writes nothing; the subdomain is decided by reading `subdomainAccess` back, so a second run enables
// nothing; and the schema reconcile is an upsert. What a re-run does do is redeploy — that is what
// "deploy" means, and the platform keeps the previous version serving whenever the new one fails its
// readiness gate.

import { readEnvironmentName } from '@fabrika/auth-core'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import {
	type Sleeper,
	ZEROPS_ACTIVE,
	ZEROPS_SERVICE_NOT_HTTP,
	ZEROPS_TERMINAL,
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsService,
} from '@fabrika/provider-zerops'
import { encodeProxyManifestJson, FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'
import { PLATFORM_CONSOLE_APP_SCHEMA } from '../zerops/generated/platform-console-schema'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '../zerops/generated/platform-proxy-manifest'
import type { PlatformDeployInput } from './deploy-options'
import { derivePlatformHosts, platformOrigin, type PlatformPlacement, ZEROPS_SUBDOMAIN_VARIABLE } from './hosts'
import type { DeployLog } from './log'
import { mergePlatformProxyManifest, readLiveProxyManifest } from './manifest'
import { platformProxyAppFor, resolvePlatformProxyManifest } from './proxy-manifest'

/**
 * The five services this command deploys, IN THE ORDER IT DEPLOYS THEM.
 *
 * IAM first because everything authenticates against it; Operations and source before their control
 * consumers; **the proxy before control** because enforcement must never describe an older version of
 * the gate modules than the code behind it; control last.
 *
 * Each name is a service hostname in the topology AND the `zerops.yaml` setup name the pipeline
 * selects — the platform's own "setup name defaults to the hostname" rule.
 * `zerops/__tests__/deploy-order.test.ts` pins both against the declarations that own them.
 */
export const PLATFORM_DEPLOY_ORDER = ['iam', 'operations', 'source', 'proxy', 'control'] as const

export type PlatformDeployService = (typeof PLATFORM_DEPLOY_ORDER)[number]

/** The proxy's hostname. The only publicly routed service, and the one that carries the manifest. */
export const PLATFORM_PROXY_SERVICE = 'proxy'

/** How often a triggered pipeline is polled. */
const POLL_INTERVAL_MS = 5_000
/** Zerops caps a build pipeline at one hour; poll past that so the timeout is ours, not a coincidence. */
const POLL_ATTEMPTS = (70 * 60_000) / POLL_INTERVAL_MS
/** How long to wait for a triggered version to appear when the trigger response did not name one. */
const VERSION_APPEARS_ATTEMPTS = 12
/** One live run read `subdomainAccess: false` right after a successful enable and `true` 3 s later. */
const SUBDOMAIN_READBACK_ATTEMPTS = 10

/**
 * The platform's code for "a userData synchronisation is already running for this service".
 *
 * Observed live (`docs/reference/zerops-platform.md`): a deploy racing an environment write dies on it
 * and leaves the app version stuck `UPLOADING`, which nothing recovers from. This command writes
 * variables and then deploys, so it is exactly the caller that race was recorded against — retrying
 * the TRIGGER is the whole mitigation, and it is bounded so a genuine misconfiguration still fails.
 */
const USER_DATA_SYNC_RUNNING = 'userDataSyncRunning'
const TRIGGER_RETRY_ATTEMPTS = 6

/**
 * What deploying ONE service needs. Narrower than the whole command's collaborators so the bring-up
 * (`install.ts`), which deploys the proxy alone before any manifest exists, can reuse `deployPlatformService`
 * without inventing an IAM reconciler it has no use for.
 */
export interface PlatformServiceDeployCollaborators {
	readonly api: ZeropsApi
	readonly sleep: Sleeper
	readonly log: DeployLog
	readonly signal: AbortSignal
}

/** Everything `deployPlatform` reaches the outside world through. */
export interface PlatformDeployCollaborators extends PlatformServiceDeployCollaborators {
	readonly reconcileSchema: SchemaReconciler
}

/** What deploying ONE service needs from the caller's input. `PlatformDeployInput` satisfies it. */
export interface PlatformServiceDeployInput {
	/** Public Git repository URL for a one-time build. Omitted uses the service's own Git integration. */
	readonly buildFromGit?: string
	readonly dryRun: boolean
}

/** One resolved platform service. */
export interface ResolvedService {
	readonly hostname: PlatformDeployService
	readonly id: string
}

const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new Error('the Zerops platform deploy was cancelled')
	}
}

const resolveProject = async (
	input: PlatformDeployInput,
	{ api, signal }: PlatformDeployCollaborators,
): Promise<{ id: string; name: string }> => {
	if (input.project.kind === 'id') {
		const project = await api.getProject({ projectId: input.project.projectId, signal })
		if (project.id === '') {
			throw new Error(`Zerops project ${input.project.projectId} could not be read`)
		}
		return { id: project.id, name: project.name }
	}
	const matches = await api.findProjects({ clientId: input.project.clientId, name: input.project.name, signal })
	if (matches.length === 0) {
		throw new Error(`no Zerops project named \`${input.project.name}\` under this client`)
	}
	if (matches.length > 1) {
		// Zerops allows duplicate project names, so picking one would make the deploy's target depend on
		// the API's list order. Name the id instead.
		throw new Error(`${matches.length} Zerops projects are named \`${input.project.name}\` — select one with --project-id`)
	}
	const project = matches[0]
	if (project === undefined || project.id === '') {
		throw new Error(`the Zerops project named \`${input.project.name}\` has no id`)
	}
	return { id: project.id, name: project.name }
}

/**
 * Find every platform service by hostname in one listing.
 *
 * One call rather than four `findService` lookups, so a missing service is reported as the whole set
 * that is missing — an installation that was never imported fails once, naming all of it, rather than
 * four runs later. Build runtimes (`build<hostname>v<n>`) share the project and are ignored by the
 * exact-name match.
 */
const resolveServices = async (
	projectId: string,
	{ api, signal }: PlatformDeployCollaborators,
): Promise<Map<PlatformDeployService, ResolvedService>> => {
	const services = await api.listProjectServices({ projectId, signal })
	const resolved = new Map<PlatformDeployService, ResolvedService>()
	const missing: string[] = []
	for (const hostname of PLATFORM_DEPLOY_ORDER) {
		const matches = services.filter((service: ZeropsService) => service.name === hostname)
		if (matches.length > 1) {
			throw new Error(`Zerops project ${projectId} has ${matches.length} services named \`${hostname}\``)
		}
		const match = matches[0]
		if (match === undefined || match.id === '') {
			missing.push(hostname)
			continue
		}
		resolved.set(hostname, { hostname, id: match.id })
	}
	if (missing.length > 0) {
		throw new Error(
			`Zerops project ${projectId} has no ${missing.join(', ')} service — \`platform deploy\` updates an installation, `
				+ 'it does not create one',
		)
	}
	return resolved
}

const serviceOf = (services: ReadonlyMap<PlatformDeployService, ResolvedService>, hostname: PlatformDeployService): ResolvedService => {
	const service = services.get(hostname)
	if (service === undefined) {
		throw new Error(`the \`${hostname}\` service was not resolved`)
	}
	return service
}

/** Read one service's environment as a key → value map. Values are never logged. */
export const readServiceEnv = async (
	serviceId: string,
	{ api, signal }: Pick<PlatformServiceDeployCollaborators, 'api' | 'signal'>,
): Promise<Map<string, string>> => {
	const variables = await api.listServiceEnv({ serviceId, signal })
	return new Map(variables.map((variable) => [variable.key, variable.content]))
}

/**
 * Decide where this installation answers.
 *
 * Naming no host derives them from the proxy's Zerops subdomains AND makes this a `zerops-subdomain`
 * installation, whose public entry point the deploy ensures. Naming all three makes it a
 * `custom-domain` installation, where the domains are bound to the project balancer out of band and
 * publishing a subdomain would add a public address nobody asked for.
 */
const resolvePlacement = (input: PlatformDeployInput, proxyEnv: ReadonlyMap<string, string>): PlatformPlacement => {
	if (input.hosts !== undefined) {
		return { hosts: input.hosts, scheme: input.scheme, zeropsSubdomain: false }
	}
	const subdomains = proxyEnv.get(ZEROPS_SUBDOMAIN_VARIABLE)
	if (subdomains === undefined || subdomains.trim() === '') {
		throw new Error(
			'the proxy service publishes no Zerops subdomain — deploy it once so it has HTTP ports, or name every host '
				+ 'explicitly with --iam-host / --console-host / --operations-host',
		)
	}
	const listeners = PLATFORM_PROXY_MANIFEST_TEMPLATE.apps.map((app) => ({ service: app.service, port: app.port }))
	return { hosts: derivePlatformHosts(subdomains, listeners), scheme: input.scheme, zeropsSubdomain: true }
}

/**
 * The per-installation configuration each service needs, derived from the resolved hosts.
 *
 * Every value here is a hostname, an origin or the environment name. Nothing in this map is a secret,
 * which is what lets the deploy compare each key against the live value before writing it.
 */
const desiredServiceEnv = (
	environment: string,
	placement: PlatformPlacement,
	manifestJson: string,
): ReadonlyMap<PlatformDeployService, ReadonlyMap<string, string>> => {
	const iamOrigin = platformOrigin(placement.scheme, placement.hosts.iam)
	const consoleOrigin = platformOrigin(placement.scheme, placement.hosts.control)
	const operationsOrigin = platformOrigin(placement.scheme, placement.hosts.operations)
	return new Map<PlatformDeployService, ReadonlyMap<string, string>>([
		[
			'iam',
			new Map([
				['ENVIRONMENT', environment],
				// The `iss` of every minted token AND the OIDC redirect base, so it must be the address
				// routed to the proxy in front of this service.
				['ISSUER', iamOrigin],
				// Which browser origins may drive `/admin/*`. IAM cannot derive the console's domain; an
				// empty registry closes the console's whole Access plane.
				['FABRIKA_IAM_ADMIN_ORIGINS', JSON.stringify([consoleOrigin])],
			]),
		],
		[
			'operations',
			new Map([
				['ENVIRONMENT', environment],
				['FABRIKA_IAM_ISSUER', iamOrigin],
				['FABRIKA_OPERATIONS_PUBLIC_HOST', placement.hosts.operations],
			]),
		],
		['source', new Map()],
		[
			'proxy',
			new Map([
				['ENVIRONMENT', environment],
				// Compared byte-for-byte against a token's `iss`, so this is the PUBLIC issuer and not the
				// private `iam:3000` the manifest dials — `readProxyEnv` canonicalizes it to an origin.
				['FABRIKA_IAM_ISSUER', iamOrigin],
				[FABRIKA_PROXY_MANIFEST_JSON, manifestJson],
			]),
		],
		[
			'control',
			new Map([
				['ENVIRONMENT', environment],
				['FABRIKA_IAM_ISSUER', iamOrigin],
				// A bare host: `controlPublicOrigin` accepts either spelling, and this is also what the
				// same-origin check on both first-party gateways is decided against.
				['FABRIKA_CONTROL_DOMAIN', placement.hosts.control],
				['OPERATIONS_ARTIFACT_ORIGIN', operationsOrigin],
				// The public IAM origin an APPLICATION project's proxy reaches — there is no private
				// network between projects (ADR-0006).
				['FABRIKA_ZEROPS_PROXY_IAM_URL', iamOrigin],
			]),
		],
	])
}

/** Write only what differs. Returns the KEYS written — never a value, not even in a debug line. */
const applyServiceEnv = async (
	service: ResolvedService,
	desired: ReadonlyMap<string, string>,
	live: ReadonlyMap<string, string>,
	input: PlatformDeployInput,
	collaborators: PlatformDeployCollaborators,
): Promise<string[]> => {
	const written: string[] = []
	for (const [key, value] of desired) {
		if (live.get(key) === value) {
			continue
		}
		written.push(key)
		if (input.dryRun) {
			continue
		}
		assertRunning(collaborators.signal)
		await collaborators.api.putServiceEnv({ serviceId: service.id, key, value, signal: collaborators.signal })
	}
	return written
}

/** Trigger one service's pipeline, riding out a userData synchronisation that has not settled yet. */
const triggerPipeline = async (
	service: ResolvedService,
	input: PlatformServiceDeployInput,
	{ api, sleep, log, signal }: PlatformServiceDeployCollaborators,
): Promise<string | undefined> => {
	for (let attempt = 0;; attempt += 1) {
		assertRunning(signal)
		try {
			const process = await api.triggerPipeline({
				serviceId: service.id,
				zeropsSetup: service.hostname,
				...(input.buildFromGit === undefined ? {} : { buildFromGit: input.buildFromGit }),
				signal,
			})
			const appVersionId = process?.appVersionId
			return appVersionId === undefined || appVersionId === '' ? undefined : appVersionId
		} catch (error) {
			if (attempt >= TRIGGER_RETRY_ATTEMPTS || !(error instanceof ZeropsApiError) || error.code !== USER_DATA_SYNC_RUNNING) {
				throw error
			}
			log.info(`${service.hostname}: the platform is still synchronising this service's variables — retrying the trigger`)
			await sleep(POLL_INTERVAL_MS, signal)
		}
	}
}

/** The version a trigger produced, when the trigger response did not name one (every field is optional). */
const awaitNewVersion = async (
	service: ResolvedService,
	baseline: number,
	{ api, sleep, signal }: PlatformServiceDeployCollaborators,
): Promise<string> => {
	for (let attempt = 0;; attempt += 1) {
		assertRunning(signal)
		const latest = await api.latestAppVersion({ serviceId: service.id, signal })
		if (latest !== null && latest.id !== '' && (latest.sequence ?? -1) > baseline) {
			return latest.id
		}
		if (attempt >= VERSION_APPEARS_ATTEMPTS) {
			throw new Error(`zerops: the \`${service.hostname}\` pipeline was triggered but no new app-version appeared`)
		}
		await sleep(POLL_INTERVAL_MS, signal)
	}
}

/**
 * Deploy ONE service and wait for it to become the active version.
 *
 * A failed deploy throws, which stops the sequence: the platform keeps the previous version serving
 * (`deploy.readinessCheck` is a real gate, live-verified), so a failure here leaves the installation
 * consistent — old code behind the manifest that was written for it.
 *
 * Exported for the BRING-UP, which builds the proxy on its own before any manifest exists so that the
 * service publishes the HTTP ports its public hostnames are named after (`install.ts`, pass 1). That is
 * one service, not an order — the order below stays this file's.
 */
export const deployPlatformService = async (
	service: ResolvedService,
	input: PlatformServiceDeployInput,
	collaborators: PlatformServiceDeployCollaborators,
): Promise<void> => {
	const { api, sleep, log, signal } = collaborators
	if (input.dryRun) {
		log.info(`${service.hostname}: would trigger its pipeline and wait for the new version to become ACTIVE`)
		return
	}
	const prior = await api.latestAppVersion({ serviceId: service.id, signal })
	const baseline = prior?.sequence ?? -1
	const triggered = await triggerPipeline(service, input, collaborators)
	const appVersionId = triggered ?? await awaitNewVersion(service, baseline, collaborators)
	log.info(`${service.hostname}: app-version ${appVersionId} building`)
	for (let attempt = 0;; attempt += 1) {
		assertRunning(signal)
		const version = await api.getAppVersion({ appVersionId, signal })
		// An unknown status means this build does not recognise what Zerops sent — keep waiting, never
		// read it as success or failure.
		if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) {
			if (version.status !== ZEROPS_ACTIVE) {
				throw new Error(`zerops: the \`${service.hostname}\` deploy ${appVersionId} finished as ${version.status}`)
			}
			log.info(`${service.hostname}: ACTIVE`)
			return
		}
		if (attempt >= POLL_ATTEMPTS) {
			throw new Error(`zerops: the \`${service.hostname}\` deploy ${appVersionId} did not finish in time`)
		}
		await sleep(POLL_INTERVAL_MS, signal)
	}
}

/**
 * Publish the proxy on its `*.zerops.app` subdomain — the one thing an import document cannot do.
 *
 * The decision is the READ-BACK and never the call returning: on an already-published service the
 * platform answers 2xx and then fails the process it hands back, and a freshly-enabled one can still
 * read `false` on the next read. Both live-verified. Runs on every deploy, so a subdomain someone
 * turned off in the GUI comes back, and throws rather than leaving the installation unreachable.
 */
const ensureSubdomainAccess = async (
	proxy: ResolvedService,
	input: PlatformDeployInput,
	{ api, sleep, log, signal }: PlatformDeployCollaborators,
): Promise<void> => {
	const published = async (): Promise<boolean> => (await api.getService({ serviceId: proxy.id, signal })).subdomainAccess === true
	if (await published()) {
		log.info('the proxy is already published on its Zerops subdomain')
		return
	}
	if (input.dryRun) {
		log.info('the proxy is NOT published on its Zerops subdomain; would enable it')
		return
	}
	try {
		await api.enableSubdomainAccess({ serviceId: proxy.id, signal })
	} catch (error) {
		if (error instanceof ZeropsApiError && error.code === ZEROPS_SERVICE_NOT_HTTP) {
			throw new Error(
				`the proxy cannot be published on a zerops.app subdomain: it exposes no deployed HTTP port (${ZEROPS_SERVICE_NOT_HTTP})`,
			)
		}
		throw error
	}
	for (let attempt = 0;; attempt += 1) {
		assertRunning(signal)
		if (await published()) {
			log.info('the proxy is published on its Zerops subdomain')
			return
		}
		if (attempt >= SUBDOMAIN_READBACK_ATTEMPTS) {
			throw new Error(
				'the proxy accepted enable-subdomain-access but still reads subdomainAccess: false — the installation has no public entry point',
			)
		}
		await sleep(POLL_INTERVAL_MS, signal)
	}
}

/**
 * The installation's environment name, refused when a public origin contradicts it.
 *
 * The same rule the services enforce at boot (`readEnvironmentName`, `@fabrika/auth-core`), applied
 * HERE so a deploy that would make IAM or control refuse to start fails before it writes anything.
 * Both origins are checked because both services state one: IAM's `ISSUER` and control's
 * `FABRIKA_CONTROL_DOMAIN` are what each of them enforces against.
 */
const checkedEnvironmentName = (environment: string, placement: PlatformPlacement): string => {
	readEnvironmentName(environment, platformOrigin(placement.scheme, placement.hosts.iam))
	return readEnvironmentName(environment, platformOrigin(placement.scheme, placement.hosts.control))
}

/**
 * Bring one Zerops platform installation to this checkout, unattended.
 *
 * Every step is idempotent and the whole sequence fails closed: nothing is deployed until the manifest
 * and the environment name have been applied, and nothing after a failed step runs.
 */
export const deployPlatform = async (
	input: PlatformDeployInput,
	collaborators: PlatformDeployCollaborators,
): Promise<void> => {
	const { log, signal } = collaborators
	assertRunning(signal)

	log.step('Resolve the installation')
	const project = await resolveProject(input, collaborators)
	const services = await resolveServices(project.id, collaborators)
	log.info(`project ${project.name} (${project.id}) — ${PLATFORM_DEPLOY_ORDER.join(', ')}`)

	const proxy = serviceOf(services, PLATFORM_PROXY_SERVICE)
	const proxyEnv = await readServiceEnv(proxy.id, collaborators)
	const placement = resolvePlacement(input, proxyEnv)
	const environment = checkedEnvironmentName(input.environment, placement)
	log.info(`environment \`${environment}\`, ${placement.scheme}://${placement.hosts.control} (console)`)
	log.info(`iam ${placement.hosts.iam} · operations ${placement.hosts.operations}`)

	log.step('Compose the proxy manifest')
	const platformManifest = resolvePlatformProxyManifest(PLATFORM_PROXY_MANIFEST_TEMPLATE, {
		scheme: placement.scheme,
		placement: {
			iam: { hosts: [placement.hosts.iam] },
			control: { hosts: [placement.hosts.control] },
			operations: { hosts: [placement.hosts.operations] },
		},
	})
	const merged = mergePlatformProxyManifest(platformManifest, readLiveProxyManifest(proxyEnv.get(FABRIKA_PROXY_MANIFEST_JSON)))
	log.info(`${merged.manifest.apps.length} app(s): ${merged.manifest.apps.map((app) => app.id).join(', ')}`)
	if (merged.carried.length > 0) {
		log.info(`carried through from the live manifest: ${merged.carried.join(', ')}`)
	}
	for (const displaced of merged.superseded) {
		log.warn(
			`the live manifest entry \`${displaced.id}\` stood on the platform host ${displaced.host} and was replaced — `
				+ 'that host now answers for the platform app that owns it',
		)
	}

	log.step('Write the service environment')
	const desired = desiredServiceEnv(environment, placement, encodeProxyManifestJson(merged.manifest))
	for (const hostname of PLATFORM_DEPLOY_ORDER) {
		const service = serviceOf(services, hostname)
		const live = hostname === PLATFORM_PROXY_SERVICE ? proxyEnv : await readServiceEnv(service.id, collaborators)
		const keys = desired.get(hostname) ?? new Map<string, string>()
		const written = await applyServiceEnv(service, keys, live, input, collaborators)
		log.info(
			written.length === 0
				? `${hostname}: ${keys.size} variable(s) already correct`
				: `${hostname}: ${input.dryRun ? 'would write' : 'wrote'} ${written.join(', ')}`,
		)
	}

	// EVERY deploy is after EVERY write. That is what makes the sequence fail closed: a manifest this
	// command could not apply leaves the previous manifest in front of the previous code, never in front
	// of new code — and `ENVIRONMENT` is in place before any service that refuses `local` restarts.
	log.step(`Deploy ${PLATFORM_DEPLOY_ORDER.join(' → ')}`)
	for (const hostname of PLATFORM_DEPLOY_ORDER) {
		await deployPlatformService(serviceOf(services, hostname), input, collaborators)
	}

	// BEFORE the console registration, not after: that step talks to IAM over its PUBLIC host, and on a
	// first bring-up the proxy has no public address until this runs — every call 502s. On an already
	// published installation this is a no-op, which is why the old order survived until `platform install`
	// ran it on an empty project. Publishing first is not a widening: the proxy enforces the manifest it
	// was just built with (ADR-0022), and registration only teaches IAM where a session may return to.
	log.step('Ensure the public entry point')
	if (placement.zeropsSubdomain) {
		await ensureSubdomainAccess(proxy, input, collaborators)
	} else {
		log.info('custom-domain installation: the operator binds each domain to the project balancer; no subdomain is published')
	}

	log.step('Register the console with IAM')
	const consoleApp = platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control')
	const consoleOrigin = platformOrigin(placement.scheme, placement.hosts.control)
	if (input.dryRun) {
		log.info(`would reconcile \`${consoleApp.id}\` and register its return origin ${consoleOrigin}`)
	} else {
		// The schema PUT is what REGISTERS the app, and `apps.setReturnOrigins` 404s for an app IAM has
		// never heard of — so both travel in this one call, in that order (ADR-0021/ADR-0023).
		await collaborators.reconcileSchema({
			url: platformOrigin(placement.scheme, placement.hosts.iam),
			app: consoleApp.id,
			schema: PLATFORM_CONSOLE_APP_SCHEMA,
			returnOrigins: [consoleOrigin],
			adminKey: input.iamAdminKey,
			signal,
		})
		log.info(`\`${consoleApp.id}\` reconciled; return origin ${consoleOrigin}`)
	}

	log.step(input.dryRun ? 'Dry run complete — nothing was written' : 'Installation deployed')
}
