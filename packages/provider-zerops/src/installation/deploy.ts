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
//     front of it leaves `/api/*` open for the length of the deploy. The sequence is therefore
//     (IAM + Operations) → **proxy** → control: the two that order nothing against each
//     other built at once, with the enforcement point ahead of the service whose table just widened.
//     `__tests__/deploy.test.ts` pins it.
//
// Bringing `fabrika-test` to HEAD on 2026-08-05 took `zops push` from a laptop, once per service, in a
// hand-chosen order, and everything that made that run correct stayed in a run log. This file is that
// run log, executable.
//
// ── What this command writes, and what it deliberately does not ───────────────────────────────────
//
// It composes the proxy manifest and ships it in the proxy's build archive. It writes the exact namespace
// planning source default and the per-installation configuration derived from the resolved public hosts
// (each service's own origin, the origins it must know about, and the installation's environment name),
// and the platform database's backup schedule. **It writes one credential, and only a derived one**: the
// secret the proxy proves its requests to IAM with, HMAC-SHA256 of a fixed label keyed by the IAM admin key,
// written sensitive to `proxy` and `iam` and never read back. Every other secret an installation holds is
// `platform install`'s to place. The two credentials this command HOLDS are the Zerops access token and the
// IAM admin key, both from the environment, neither ever logged.
//
// ── Idempotence ───────────────────────────────────────────────────────────────────────────────────
//
// Every readable variable is READ before it is written and skipped when it already matches, so a second
// run writes only the derived secret, which it cannot read back; the subdomain is decided by reading
// `subdomainAccess` back, so a second run enables nothing; the database's backup period is read and set
// only when it differs; and the schema reconcile is an upsert. What a re-run does do is redeploy — that is
// what "deploy" means, and the platform keeps the previous version serving whenever the new one fails its
// readiness gate.

import { FABRIKA_SERVICE_TABLE_DIGEST, IAM_PROXY_SECRET_VARIABLE, readEnvironmentName } from '@fabrika/auth-core'
import { IAM_APP_ID, IAM_APP_SCHEMA } from '@fabrika/iam-contract'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import { encodeProxyManifestJson, FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-core/manifest'
import { createHmac } from 'node:crypto'
import { assertServiceEnvValueFits } from '../api'
import {
	enableSubdomainAccessWhenHttp,
	prepareZeropsDescriptor,
	readableContent,
	type Sleeper,
	waitForProcess,
	ZEROPS_ACTIVE,
	ZEROPS_SERVICE_NOT_HTTP,
	ZEROPS_TERMINAL,
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsNamespaceProxySource,
	type ZeropsProcess,
	type ZeropsService,
	type ZeropsServiceEnv,
} from '../index'
import { ZEROPS_PROXY_MANIFEST_PATH } from '../proxy-manifest-carrier'
import { assertCheckerPublished, type CheckerPublication } from './checker-release'
import type { PlatformDeployInput } from './deploy-options'
import { PLATFORM_CONSOLE_APP_SCHEMA } from './generated/platform-console-schema'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from './generated/platform-proxy-manifest'
import { derivePlatformHosts, platformOrigin, type PlatformPlacement, ZEROPS_SUBDOMAIN_VARIABLE } from './hosts'
import { PRIVATE_IAM_UPSTREAM } from './install-environment'
import {
	FABRIKA_ZEROPS_PROXY_SOURCE_JSON,
	type PlatformSourcePreparer,
	prepareNamespaceProxySource,
	serializeNamespaceProxySource,
	validateInstallationSetups,
} from './installation-source'
import type { DeployLog } from './log'
import { type IamOAuthConfig, platformIamOAuthConfig } from './mcp'
import { archiveWithDataFile } from './platform-archive'
import type { PreparedPlatformSource } from './platform-source'
import { type PlatformUploadFetch, uploadPlatformArchive } from './platform-upload'
import { platformProxyAppFor, type PlatformProxyComposition, platformServiceTableDigest, resolvePlatformProxyManifest } from './proxy-manifest'

/**
 * The four services this command touches, in the order it RESOLVES and WRITES them.
 *
 * It is no longer the order they are deployed in — that is `PLATFORM_CONCURRENT_DEPLOY` followed by
 * `PLATFORM_SEQUENTIAL_DEPLOY`, and the two stages concatenate back to this list (pinned by
 * `deploy-order.test.ts` in `@fabrika/platform-artifacts`). What this list still decides is which services must exist
 * and which environment is written, both of which happen for ALL FOUR before any of them is deployed.
 *
 * Each name is a service hostname in the topology AND the `zerops.yaml` setup name the pipeline
 * selects — the platform's own "setup name defaults to the hostname" rule.
 * `deploy-order.test.ts` in `@fabrika/platform-artifacts` pins both against the declarations that own them.
 */
export const PLATFORM_DEPLOY_ORDER = ['iam', 'operations', 'proxy', 'control'] as const

export type PlatformDeployService = (typeof PLATFORM_DEPLOY_ORDER)[number]

/**
 * The two services built AT ONCE, because nothing orders them against each other.
 *
 * Neither calls a sibling at boot: IAM holds no sibling origin at all, and Operations only
 * CONSTRUCTS its IAM client (the first request is the first call). Each readiness gate hits the
 * service's own `/healthz`, and no deploy-written variable of one is read by another's BUILD — the
 * only build-time read on the whole path is the proxy reading its own manifest. So the order among them was arbitrary, and paying for it sequentially cost about 3 min 45 s
 * of the ~9 min 35 s a warm five-service roll took (two measured runs, 2026-08-21).
 *
 * What is NOT arbitrary stays: every environment write happens before any of these starts, the proxy
 * is deployed after both, and control after the proxy (ADR-0022 — the enforcement point ahead of
 * the service whose table just widened). `deploy-order.test.ts` in `@fabrika/platform-artifacts` and
 * `__tests__/deploy.test.ts` fail if that sequence changes.
 */
export const PLATFORM_CONCURRENT_DEPLOY = ['iam', 'operations'] as const

/** What is deployed after the concurrent stage, one at a time and in this order. */
export const PLATFORM_SEQUENTIAL_DEPLOY = ['proxy', 'control'] as const

/** The proxy's hostname. The only publicly routed service, and the one that carries the manifest. */
export const PLATFORM_PROXY_SERVICE = 'proxy'

/** IAM's and control's database, on both tiers. This command deploys nothing to it; it sets its backup schedule. */
export const PLATFORM_DATABASE_SERVICE = 'db'

/**
 * Hourly. Zerops has no point-in-time recovery: a single-node database loses everything since its last `pg_dump`, which
 * by default is daily. UNVERIFIED: that `backupPeriod` takes this 5-field cron, as the GUI documentation describes.
 */
export const PLATFORM_DATABASE_BACKUP_PERIOD = '0 * * * *'

/** How often a triggered pipeline is polled. */
const POLL_INTERVAL_MS = 5_000
/** Zerops caps a build pipeline at one hour; poll past that so the timeout is ours, not a coincidence. */
const POLL_ATTEMPTS = (70 * 60_000) / POLL_INTERVAL_MS
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
	readonly uploadFetch: PlatformUploadFetch
	readonly api: ZeropsApi
	readonly sleep: Sleeper
	readonly log: DeployLog
	readonly signal: AbortSignal
}

/** Everything `deployPlatform` reaches the outside world through. */
export interface PlatformDeployCollaborators extends PlatformServiceDeployCollaborators {
	readonly prepareSource: PlatformSourcePreparer
	readonly checkerPublished: CheckerPublication
	readonly reconcileSchema: SchemaReconciler
}

/** The prepared snapshot shared by every build in an installation run. */
export interface PlatformServiceDeployInput {
	readonly source: PreparedPlatformSource
	readonly dryRun: boolean
	/** The proxy's manifest, which its archive carries as the one data file (ADR-0045); the proxy is refused without it. */
	readonly proxyManifest?: string
}

/** The archive one service builds from: the snapshot, and for the proxy the snapshot plus its manifest. */
const serviceArchive = async (service: ResolvedService, input: PlatformServiceDeployInput): Promise<Blob> => {
	const snapshot = Bun.file(input.source.archivePath)
	if (service.hostname !== PLATFORM_PROXY_SERVICE) return snapshot
	if (input.proxyManifest === undefined) throw new Error('the proxy is built only with the manifest its archive carries')
	return new Blob([archiveWithDataFile(await snapshot.bytes(), { path: ZEROPS_PROXY_MANIFEST_PATH, contents: input.proxyManifest })])
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

/** The private source service of an earlier layout; Control now streams sources itself (ADR-0029). */
const LEFTOVER_SOURCE_SERVICE = 'source'

/** The services this command touches: the four it deploys, and the database whose backups it schedules. */
interface ResolvedInstallation {
	readonly services: ReadonlyMap<PlatformDeployService, ResolvedService>
	readonly databaseId: string
}

/**
 * Find every platform service by hostname in one listing.
 *
 * One call rather than five `findService` lookups, so a missing service is reported as the whole set
 * that is missing — an installation that was never imported fails once, naming all of it, rather than
 * five runs later. Build runtimes (`build<hostname>v<n>`) share the project and are ignored by the
 * exact-name match.
 */
const resolveServices = async (
	projectId: string,
	{ api, log, signal }: PlatformDeployCollaborators,
): Promise<ResolvedInstallation> => {
	const services = await api.listProjectServices({ projectId, signal })
	if (services.some((service: ZeropsService) => service.name === LEFTOVER_SOURCE_SERVICE)) {
		log.warn('a `source` service from an earlier layout is present and unused; it may still hold GitHub App keys; delete it or reinstall')
	}
	const idOf = (hostname: string): string | undefined => {
		const matches = services.filter((service: ZeropsService) => service.name === hostname)
		if (matches.length > 1) {
			throw new Error(`Zerops project ${projectId} has ${matches.length} services named \`${hostname}\``)
		}
		const match = matches[0]
		return match === undefined || match.id === '' ? undefined : match.id
	}
	const resolved = new Map<PlatformDeployService, ResolvedService>()
	const missing: string[] = []
	for (const hostname of PLATFORM_DEPLOY_ORDER) {
		const id = idOf(hostname)
		if (id === undefined) {
			missing.push(hostname)
			continue
		}
		resolved.set(hostname, { hostname, id })
	}
	const databaseId = idOf(PLATFORM_DATABASE_SERVICE)
	if (databaseId === undefined) {
		missing.push(PLATFORM_DATABASE_SERVICE)
	}
	if (missing.length > 0 || databaseId === undefined) {
		throw new Error(
			`Zerops project ${projectId} has no ${missing.join(', ')} service — \`platform deploy\` updates an installation, `
				+ 'it does not create one',
		)
	}
	return { services: resolved, databaseId }
}

export const serviceOf = (services: ReadonlyMap<PlatformDeployService, ResolvedService>, hostname: PlatformDeployService): ResolvedService => {
	const service = services.get(hostname)
	if (service === undefined) {
		throw new Error(`the \`${hostname}\` service was not resolved`)
	}
	return service
}

/** One service's environment by key. A sensitive record carries no value. Values are never logged. */
export type LiveServiceEnv = ReadonlyMap<string, ZeropsServiceEnv>

/** Read one service's environment by key. */
export const readServiceEnv = async (
	serviceId: string,
	{ api, signal }: Pick<PlatformServiceDeployCollaborators, 'api' | 'signal'>,
): Promise<LiveServiceEnv> => {
	const variables = await api.listServiceEnv({ serviceId, signal })
	return new Map(variables.map((variable) => [variable.key, variable]))
}

/**
 * Decide where this installation answers.
 *
 * Naming no host derives them from the proxy's Zerops subdomains AND makes this a `zerops-subdomain`
 * installation, whose public entry point the deploy ensures. Naming all three makes it a
 * `custom-domain` installation, where the domains are bound to the project balancer out of band and
 * publishing a subdomain would add a public address nobody asked for.
 */
const resolvePlacement = (input: PlatformDeployInput, proxyEnv: LiveServiceEnv): PlatformPlacement => {
	if (input.hosts !== undefined) {
		return { hosts: input.hosts, scheme: input.scheme, zeropsSubdomain: false }
	}
	const subdomains = readableContent(proxyEnv.get(ZEROPS_SUBDOMAIN_VARIABLE))
	if (subdomains === undefined || subdomains.trim() === '') {
		throw new Error(
			'the proxy service publishes no Zerops subdomain — deploy it once so it has HTTP ports, or name every host '
				+ 'explicitly with --iam-host / --console-host / --operations-host',
		)
	}
	const listeners = PLATFORM_PROXY_MANIFEST_TEMPLATE.apps.map((app) => ({ service: app.service, port: app.port }))
	return { hosts: derivePlatformHosts(subdomains, listeners), scheme: input.scheme, zeropsSubdomain: true }
}

const IAM_OAUTH_CONFIG = 'FABRIKA_IAM_OAUTH_CONFIG'

/**
 * The secret the platform proxy sends IAM's route, so IAM honours the client address and request id only from the proxy.
 * Derived from the IAM admin key, which every deploy holds, so each deploy writes the same value and nothing stores or
 * reads one back. Never from the proxy key: namespace proxies hold that one.
 */
const deriveIamProxySecret = (iamAdminKey: string): string =>
	createHmac('sha256', iamAdminKey).update('fabrika-installation-proxy-secret:iam').digest('hex')

/** The credentials this command writes. Sensitive, so they cannot be compared and are rewritten on every deploy. */
const SENSITIVE_DEPLOY_KEYS: ReadonlySet<string> = new Set([IAM_PROXY_SECRET_VARIABLE])

/**
 * The per-installation configuration each service needs, derived from the resolved hosts.
 *
 * The namespace source default comes from the verified snapshot. Values are compared but never logged.
 * IAM's OAuth configuration is written only when MCP authoring is enabled; without it the variable is
 * left as it is, and the manifest — whose `/mcp` row then admits no OAuth token — is what turns MCP off.
 */
const desiredServiceEnv = (
	environment: string,
	projectId: string,
	placement: PlatformPlacement,
	proxySource: ZeropsNamespaceProxySource,
	oauthConfig: IamOAuthConfig | undefined,
	controlTableDigest: string,
	iamProxySecret: string,
): ReadonlyMap<PlatformDeployService, ReadonlyMap<string, string>> => {
	const iamOrigin = platformOrigin(placement.scheme, placement.hosts.iam)
	const operationsOrigin = platformOrigin(placement.scheme, placement.hosts.operations)
	const iam = new Map([
		['ENVIRONMENT', environment],
		// The `iss` of every minted token AND the OIDC redirect base, so it must be the address
		// routed to the proxy in front of this service.
		['ISSUER', iamOrigin],
		[IAM_PROXY_SECRET_VARIABLE, iamProxySecret],
	])
	if (oauthConfig !== undefined) {
		iam.set(IAM_OAUTH_CONFIG, JSON.stringify(oauthConfig))
	}
	return new Map<PlatformDeployService, ReadonlyMap<string, string>>([
		['iam', iam],
		[
			'operations',
			new Map([
				['ENVIRONMENT', environment],
				['FABRIKA_IAM_ISSUER', iamOrigin],
				['FABRIKA_OPERATIONS_PUBLIC_HOST', placement.hosts.operations],
			]),
		],
		[
			'proxy',
			new Map([
				['ENVIRONMENT', environment],
				// Compared byte-for-byte against a token's `iss`, so this is the PUBLIC issuer and not the
				// private `iam:3000` the manifest dials — `readProxyEnv` canonicalizes it to an origin.
				['FABRIKA_IAM_ISSUER', iamOrigin],
				['FABRIKA_PROXY_SESSION_OWNER_JSON', JSON.stringify({ issuer: iamOrigin, upstream: PRIVATE_IAM_UPSTREAM })],
				// Caddy sends it on the session owner's route; IAM refuses nothing without it, so the order is free.
				[IAM_PROXY_SECRET_VARIABLE, iamProxySecret],
			]),
		],
		[
			'control',
			new Map([
				[FABRIKA_ZEROPS_PROXY_SOURCE_JSON, serializeNamespaceProxySource(proxySource)],
				['ENVIRONMENT', environment],
				['FABRIKA_IAM_ISSUER', iamOrigin],
				// A bare host: `controlPublicOrigin` accepts either spelling.
				['FABRIKA_CONTROL_DOMAIN', placement.hosts.control],
				// The digest of the console table the proxy above publishes: Control picks its own table, MCP or not,
				// by it, and refuses to start under another, so the two cannot disagree at runtime.
				[FABRIKA_SERVICE_TABLE_DIGEST, controlTableDigest],
				['OPERATIONS_ARTIFACT_ORIGIN', operationsOrigin],
				// The public IAM origin an APPLICATION project's proxy reaches — there is no private
				// network between projects (ADR-0006).
				['FABRIKA_ZEROPS_PROXY_IAM_URL', iamOrigin],
				// The installation's own project, which no deployment namespace may adopt: its proxy is the
				// platform's enforcement point, and a namespace reconcile would rebuild it with only app members.
				['FABRIKA_ZEROPS_PLATFORM_PROJECT_ID', projectId],
			]),
		],
	])
}

/**
 * Write only what differs. Returns the KEYS written — never a value, not even in a debug line.
 *
 * Everything but `SENSITIVE_DEPLOY_KEYS` is written readable. A record an older release wrote sensitive
 * reads as different and is rewritten readable, which is what lets the next deploy compare it.
 */
const applyServiceEnv = async (
	service: ResolvedService,
	desired: ReadonlyMap<string, string>,
	live: LiveServiceEnv,
	input: PlatformDeployInput,
	collaborators: PlatformDeployCollaborators,
): Promise<string[]> => {
	const written: string[] = []
	for (const [key, value] of desired) {
		const sensitive = SENSITIVE_DEPLOY_KEYS.has(key)
		if (!sensitive && readableContent(live.get(key)) === value) {
			continue
		}
		written.push(key)
		// The client refuses it too; checking here lets a dry run report what the real write would refuse.
		assertServiceEnvValueFits(key, value)
		if (input.dryRun) {
			continue
		}
		assertRunning(collaborators.signal)
		await collaborators.api.putServiceEnv({ serviceId: service.id, key, value, sensitive, signal: collaborators.signal })
	}
	return written
}

/**
 * Delete, unread, the manifest copy older releases wrote sensitive: nothing reads it, as each proxy version serves
 * the file its own build wrote, and the platform proxy fronts only the platform's apps (ADR-0034). True if one existed.
 */
const removeLegacyProxyManifest = async (
	proxyEnv: LiveServiceEnv,
	input: PlatformDeployInput,
	collaborators: PlatformDeployCollaborators,
): Promise<boolean> => {
	const legacy = proxyEnv.get(FABRIKA_PROXY_MANIFEST_JSON)
	if (legacy === undefined) {
		return false
	}
	if (!input.dryRun) {
		assertRunning(collaborators.signal)
		await collaborators.api.deleteServiceEnv({ envId: legacy.id, signal: collaborators.signal })
	}
	return true
}

/** Only a known rejection permits another request against the same reservation. */
const triggerPipeline = async (
	service: ResolvedService,
	appVersionId: string,
	input: PlatformServiceDeployInput,
	{ api, sleep, log, signal }: PlatformServiceDeployCollaborators,
): Promise<void> => {
	const descriptor = prepareZeropsDescriptor(input.source.descriptor.contents, service.hostname)
	let mayHaveStarted = false
	try {
		for (let attempt = 0;; attempt += 1) {
			assertRunning(signal)
			try {
				await api.buildAndDeployAppVersion({
					appVersionId,
					zeropsYaml: descriptor.contents,
					zeropsYamlSetup: descriptor.setup,
					signal,
				})
				mayHaveStarted = true
				return
			} catch (error) {
				if (!(error instanceof ZeropsApiError) || error.code !== USER_DATA_SYNC_RUNNING) {
					mayHaveStarted = true
					log.warn(`${service.hostname}: build response unresolved; observing app-version ${appVersionId}`)
					return
				}
				if (attempt >= TRIGGER_RETRY_ATTEMPTS) {
					throw new Error(`${service.hostname}: variable synchronisation still running; app-version ${appVersionId} was not triggered`)
				}
				log.info(`${service.hostname}: the platform is still synchronising this service's variables — retrying the trigger`)
				await sleep(POLL_INTERVAL_MS, signal)
			}
		}
	} finally {
		if (!mayHaveStarted) await cleanupReservation(service, appVersionId, { api, log })
	}
}

const cleanupReservation = async (
	service: ResolvedService,
	appVersionId: string,
	{ api, log }: Pick<PlatformServiceDeployCollaborators, 'api' | 'log'>,
): Promise<void> => {
	try {
		await api.deleteAppVersion({ appVersionId, signal: AbortSignal.timeout(5_000) })
	} catch {
		log.warn(`${service.hostname}: cleanup unresolved for app-version ${appVersionId}`)
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
	prepareZeropsDescriptor(input.source.descriptor.contents, service.hostname)
	const archive = await serviceArchive(service, input)
	const reserved = await api.createAppVersion({ serviceId: service.id, name: input.source.commitSha, signal })
	const appVersionId = reserved.id
	log.info(`${service.hostname}: app-version ${appVersionId}, commit ${input.source.commitSha}, setup ${service.hostname}`)
	try {
		await uploadPlatformArchive(reserved.uploadUrl, archive, signal, collaborators.uploadFetch)
		assertRunning(signal)
	} catch {
		await cleanupReservation(service, appVersionId, collaborators)
		throw new Error(`${service.hostname}: archive upload failed before build for app-version ${appVersionId}`)
	}
	await triggerPipeline(service, appVersionId, input, collaborators)
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
			throw new Error(`zerops: the \`${service.hostname}\` deploy ${appVersionId} is unresolved after timeout; no retry or deletion was attempted`)
		}
		await sleep(POLL_INTERVAL_MS, signal)
	}
}

/**
 * Build `PLATFORM_CONCURRENT_DEPLOY` at once, and let every one of them finish before failing.
 *
 * `allSettled` rather than `all`: a rejection from `all` would leave the other build running with
 * nobody polling it, so the command would exit while the platform was still writing app versions —
 * and the second rejection would be unhandled. Here every build is followed to a terminal status.
 *
 * EVERY failure is logged and the first is thrown, where "first" is this list's order and not the order
 * they failed in — builds that started together have no meaningful chronology, and a command that
 * reported only one of two broken services would send the operator back for a second run to find the
 * other. `deployPlatformService` names the service in each message.
 */
const deployConcurrently = async (
	services: ReadonlyMap<PlatformDeployService, ResolvedService>,
	input: PlatformServiceDeployInput,
	collaborators: PlatformDeployCollaborators,
): Promise<void> => {
	const outcomes = await Promise.allSettled(
		PLATFORM_CONCURRENT_DEPLOY.map((hostname) => deployPlatformService(serviceOf(services, hostname), input, collaborators)),
	)
	const failures = outcomes.flatMap((outcome) =>
		outcome.status === 'rejected' ? [outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason))] : []
	)
	for (const failure of failures) {
		collaborators.log.warn(failure.message)
	}
	const first = failures[0]
	if (first !== undefined) {
		throw first
	}
}

/**
 * Publish the proxy on its `*.zerops.app` subdomain — the one thing an import document cannot do.
 *
 * The decision is the READ-BACK and never the call returning: on an already-published service the
 * platform answers 2xx and then fails the process it hands back, and a freshly-enabled one can still
 * read `false` on the next read. Both live-verified. Runs on every deploy, so a subdomain someone
 * turned off in the GUI comes back, and throws rather than leaving the installation unreachable. The
 * HTTP ports lag a fresh ACTIVE version, so `serviceStackIsNotHttp` is retried for a bounded window first.
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
		await enableSubdomainAccessWhenHttp({ api, serviceId: proxy.id, sleep, signal })
	} catch (error) {
		if (error instanceof ZeropsApiError && error.code === ZEROPS_SERVICE_NOT_HTTP) {
			throw new Error(
				`the proxy cannot be published on a zerops.app subdomain: it still exposes no deployed HTTP port (${ZEROPS_SERVICE_NOT_HTTP}) minutes after its deploy`,
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

/** What `ensureBackupPeriod` found and did. */
export type BackupPeriodOutcome =
	| { readonly kind: 'unchanged' }
	| { readonly kind: 'would-change'; readonly from: string }
	| { readonly kind: 'changed'; readonly from: string }

/**
 * Set a managed service's backup period, read-compare-write.
 *
 * A different period is sent with the retention the service reads — its own, else the default — WHOLE, because a
 * PUT on this API resets what it leaves out. The decision is the read-back, never the PUT returning.
 */
export const ensureBackupPeriod = async (input: {
	readonly api: Pick<ZeropsApi, 'getBackupConfig' | 'configureBackup' | 'getProcess'>
	readonly sleep: Sleeper
	readonly signal: AbortSignal
	readonly serviceId: string
	readonly hostname: string
	readonly period: string
	readonly dryRun: boolean
}): Promise<BackupPeriodOutcome> => {
	const { api, sleep, signal, serviceId, hostname, period } = input
	const current = await api.getBackupConfig({ serviceId, signal })
	if (current.backupPeriod === period) {
		return { kind: 'unchanged' }
	}
	if (input.dryRun) {
		return { kind: 'would-change', from: current.backupPeriod }
	}
	assertRunning(signal)
	let process: ZeropsProcess | null
	try {
		process = await api.configureBackup({
			serviceId,
			backupPeriod: period,
			retentionPolicy: current.retentionPolicy ?? current.defaultRetentionPolicy,
			signal,
		})
	} catch (error) {
		if (error instanceof ZeropsApiError && error.status >= 400 && error.status < 500) {
			throw new Error(`zerops: setting the backup schedule of ${hostname} was refused (${error.code === '' ? error.status : error.code})`)
		}
		throw error
	}
	if (process !== null) {
		await waitForProcess({ api, processId: process.id, sleep, signal, label: `the backup schedule change of ${hostname}` })
	}
	const after = await api.getBackupConfig({ serviceId, signal })
	if (after.backupPeriod !== period) {
		throw new Error(`zerops: ${hostname} reads back the backup schedule \`${after.backupPeriod}\` after it was set to \`${period}\``)
	}
	return { kind: 'changed', from: current.backupPeriod }
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
	const source = await collaborators.prepareSource(input.sourceDir, collaborators.signal)
	try {
		validateInstallationSetups(source, PLATFORM_DEPLOY_ORDER)
		await assertCheckerPublished(collaborators.checkerPublished, collaborators.signal)
		await deployPreparedPlatform(input, collaborators, source)
	} finally {
		await source.dispose()
	}
}

export const deployPreparedPlatform = async (
	input: PlatformDeployInput,
	collaborators: PlatformDeployCollaborators,
	source: PreparedPlatformSource,
): Promise<void> => {
	const { log, signal } = collaborators
	assertRunning(signal)
	validateInstallationSetups(source, PLATFORM_DEPLOY_ORDER)
	const proxySource = await prepareNamespaceProxySource(source)
	log.info(`source commit ${source.commitSha}`)

	log.step('Resolve the installation')
	const project = await resolveProject(input, collaborators)
	const { services, databaseId } = await resolveServices(project.id, collaborators)
	log.info(`project ${project.name} (${project.id}) — ${PLATFORM_DEPLOY_ORDER.join(', ')}`)

	const proxy = serviceOf(services, PLATFORM_PROXY_SERVICE)
	const proxyEnv = await readServiceEnv(proxy.id, collaborators)
	const placement = resolvePlacement(input, proxyEnv)
	const environment = checkedEnvironmentName(input.environment, placement)
	log.info(`environment \`${environment}\`, ${placement.scheme}://${placement.hosts.control} (console)`)
	log.info(`iam ${placement.hosts.iam} · operations ${placement.hosts.operations}`)

	log.step('Compose the proxy manifest')
	const composition: PlatformProxyComposition = {
		scheme: placement.scheme,
		placement: {
			iam: { hosts: [placement.hosts.iam] },
			control: { hosts: [placement.hosts.control] },
			operations: { hosts: [placement.hosts.operations] },
		},
		...(input.mcpClients === undefined ? {} : { authorizationServer: platformOrigin(placement.scheme, placement.hosts.iam) }),
	}
	const platformManifest = resolvePlatformProxyManifest(PLATFORM_PROXY_MANIFEST_TEMPLATE, composition)
	const oauthConfig = input.mcpClients === undefined
		? undefined
		: platformIamOAuthConfig(PLATFORM_PROXY_MANIFEST_TEMPLATE, composition, input.mcpClients)
	log.info(
		oauthConfig === undefined
			? 'MCP authoring: off'
			: `MCP authoring: on, ${oauthConfig.clients.length} client(s), resource(s) ${oauthConfig.resources.map((entry) => entry.resource).join(', ')}`,
	)
	log.info(`${platformManifest.apps.length} app(s): ${platformManifest.apps.map((app) => app.id).join(', ')}`)

	log.step('Write the service environment')
	const controlTableDigest = platformServiceTableDigest(platformManifest, platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control').id)
	const desired = desiredServiceEnv(
		environment,
		project.id,
		placement,
		proxySource,
		oauthConfig,
		controlTableDigest,
		deriveIamProxySecret(input.iamAdminKey),
	)
	for (const hostname of PLATFORM_DEPLOY_ORDER) {
		const service = serviceOf(services, hostname)
		const live = hostname === PLATFORM_PROXY_SERVICE ? proxyEnv : await readServiceEnv(service.id, collaborators)
		const keys = desired.get(hostname) ?? new Map<string, string>()
		const liveOAuthConfig = live.get(IAM_OAUTH_CONFIG)
		const oauthStillSet = liveOAuthConfig !== undefined && (liveOAuthConfig.sensitive || liveOAuthConfig.content.trim() !== '')
		if (hostname === 'iam' && oauthConfig === undefined && oauthStillSet) {
			log.warn(`iam: MCP authoring is off but ${IAM_OAUTH_CONFIG} is still set; IAM keeps issuing MCP tokens until it is removed`)
		}
		const written = await applyServiceEnv(service, keys, live, input, collaborators)
		log.info(
			written.length === 0
				? `${hostname}: ${keys.size} variable(s) already correct`
				: `${hostname}: ${input.dryRun ? 'would write' : 'wrote'} ${written.join(', ')}`,
		)
	}
	if (await removeLegacyProxyManifest(proxyEnv, input, collaborators)) {
		log.info(
			`${PLATFORM_PROXY_SERVICE}: ${input.dryRun ? 'would remove' : 'removed'} ${FABRIKA_PROXY_MANIFEST_JSON}, the copy of the manifest a `
				+ 'release before this one kept there',
		)
	}

	// EVERY deploy is after EVERY write, and the manifest rides in the proxy's own archive. That is what makes
	// the sequence fail closed: a proxy build that does not go ACTIVE leaves the previous manifest in front of
	// the previous code, because control builds only after it — and `ENVIRONMENT` is in place before any
	// service that refuses `local` restarts.
	log.step(`Deploy ${PLATFORM_CONCURRENT_DEPLOY.join(' + ')} together, then ${PLATFORM_SEQUENTIAL_DEPLOY.join(' → ')}`)
	const buildInput = { source, dryRun: input.dryRun, proxyManifest: encodeProxyManifestJson(platformManifest) }
	await deployConcurrently(services, buildInput, collaborators)
	for (const hostname of PLATFORM_SEQUENTIAL_DEPLOY) {
		await deployPlatformService(serviceOf(services, hostname), buildInput, collaborators)
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

	log.step('Register the console and IAM with IAM')
	const consoleApp = platformProxyAppFor(PLATFORM_PROXY_MANIFEST_TEMPLATE, 'control')
	const consoleOrigin = platformOrigin(placement.scheme, placement.hosts.control)
	if (input.dryRun) {
		log.info(`would reconcile \`${consoleApp.id}\` and register its return origin ${consoleOrigin}`)
		log.info(`would reconcile \`${IAM_APP_ID}\`'s own vocabulary`)
	} else {
		// The schema PUT is what REGISTERS the app, and `apps.setReturnOrigins` 404s for an app IAM has
		// never heard of — so both travel in this one call, in that order (ADR-0022/ADR-0023).
		await collaborators.reconcileSchema({
			url: platformOrigin(placement.scheme, placement.hosts.iam),
			app: consoleApp.id,
			schema: PLATFORM_CONSOLE_APP_SCHEMA,
			returnOrigins: [consoleOrigin],
			adminKey: input.iamAdminKey,
			signal,
		})
		log.info(`\`${consoleApp.id}\` reconciled; return origin ${consoleOrigin}`)
		// IAM's own vocabulary, which `user-admin` is granted from (ADR-0058). It has no return origin.
		await collaborators.reconcileSchema({
			url: platformOrigin(placement.scheme, placement.hosts.iam),
			app: IAM_APP_ID,
			schema: IAM_APP_SCHEMA,
			adminKey: input.iamAdminKey,
			signal,
		})
		log.info(`\`${IAM_APP_ID}\` reconciled`)
	}

	// Last, so a refusal here leaves every service deployed, published and registered; the command still fails on it.
	log.step('Schedule the platform database backups')
	const backup = await ensureBackupPeriod({
		api: collaborators.api,
		sleep: collaborators.sleep,
		signal,
		serviceId: databaseId,
		hostname: PLATFORM_DATABASE_SERVICE,
		period: PLATFORM_DATABASE_BACKUP_PERIOD,
		dryRun: input.dryRun,
	})
	const schedule = `\`${PLATFORM_DATABASE_BACKUP_PERIOD}\``
	log.info(
		backup.kind === 'unchanged'
			? `${PLATFORM_DATABASE_SERVICE}: backups already run on ${schedule}`
			: `${PLATFORM_DATABASE_SERVICE}: backups ${backup.kind === 'changed' ? 'now run' : 'would run'} on ${schedule}, were \`${backup.from}\``,
	)

	log.step(input.dryRun ? 'Dry run complete — nothing was written' : 'Installation deployed')
}
