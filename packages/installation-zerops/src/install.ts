// `fabrika platform install --provider=zerops` — bring up a COMPLETE installation in a Zerops project
// the operator created empty.
//
// ── Why this is a THIRD command ───────────────────────────────────────────────────────────────────
//
// The two that already exist state, as invariants, that they cannot do this. `platform deploy` "writes
// no credential" and has no flag that could carry one; `platform init` only creates or reconciles the
// source RPC key and never owns the installation-wide secret set. A bring-up generates seven secrets
// and writes the complete environment, so it fits inside neither. It runs BEFORE `init`
// and hands `init` the provisioning key it generated.
//
// ── The sequence, and why it is two passes ────────────────────────────────────────────────────────
//
// A `zerops-subdomain` installation's public hostnames are minted by the platform, one per DEPLOYED
// HTTP port, and the proxy's ports come from its app version rather than from the import document
// (`zerops/setups.ts`'s `PROXY_PUBLIC_PORTS`). So nothing can name the addresses before the proxy has
// been built once — and the proxy manifest, which carries those addresses, has to be in place BEFORE
// the build that bakes it. The way out is that an empty manifest is a legal one: `{"apps":[]}` emits
// deny/404 routes only.
//
//   pass 1   write the proxy's three variables, build it, read `zeropsSubdomain`, derive three hosts
//   pass 2   write everything else, then hand the whole ordered deploy to `deployPlatform`
//
// This is measured rather than reasoned — `docs/reference/zerops-platform.md`, "a proxy before it
// fronts anything" (2026-08-08): the empty-manifest proxy built in ~190 s, deployed in ~60 s, reached
// ACTIVE, answered 404, and published all six per-port subdomain lines with no lag after ACTIVE.
//
// ── What this command may and may not do to a project ─────────────────────────────────────────────
//
// It is a BRING-UP and never a reconcile, and two rules follow. It never re-applies the provisioning
// document at a service that already exists — `startWithoutCode: true` at a service carrying code
// activates an EMPTY app version and demotes the running one to `BACKUP` (live-verified). And it
// refuses outright at a project that already holds this installation's generated secrets: rotating the
// vault KEK is unrecoverable and rotating the signing keys invalidates every live token, so neither may
// happen as a side effect of running a command twice.
//
// ── Credentials ───────────────────────────────────────────────────────────────────────────────────
//
// Seven generated (`secrets.ts`) plus one minted on the account — the control plane's Zerops INTEGRATION
// token, client role `NO_ACCESS` with `ADMIN` on this one project, so the installation never holds the
// account-wide personal token the operator authenticated with. NOTHING here logs a value, with one
// intentional exception stated at the end: the provisioning key is printed ONCE, because `platform
// init` asks the operator for it and it is stored nowhere else.

import {
	action as consoleAction,
	confirm as promptConfirm,
	info as consoleInfo,
	ok as consoleOk,
	step as consoleStep,
	warn as consoleWarn,
} from '@fabrika/installation-init'
import type { SchemaReconciler } from '@fabrika/provider-contract'
import {
	createZeropsApi,
	defaultSleep,
	type Sleeper,
	waitForProcess,
	type ZeropsApi,
	type ZeropsImportResult,
	type ZeropsProjectMode,
	type ZeropsService,
	type ZeropsServiceStatus,
} from '@fabrika/provider-zerops'
import { encodeProxyManifestJson, FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'
import { PLATFORM_PROXY_MANIFEST_TEMPLATE } from '../zerops/generated/platform-proxy-manifest'
import { type CompiledDocument, compileTopology, platformTopology } from '../zerops/topology'
import {
	deployPlatform,
	deployPlatformService,
	PLATFORM_DEPLOY_ORDER,
	PLATFORM_PROXY_SERVICE,
	type PlatformDeployService,
	readServiceEnv,
	type ResolvedService,
} from './deploy'
import { derivePlatformHosts, type PlatformHosts, platformOrigin, ZEROPS_SUBDOMAIN_VARIABLE } from './hosts'
import { checkedEnvironmentName } from './init'
import { type PlatformInstallInput, UNATTENDED_FLAG } from './install-options'
import type { InitLog } from './log'
import { generateInstallationSecrets, type InstallationSecrets } from './secrets'

/** The one question this command asks. Injected so the flow can be exercised without a TTY. */
export interface InstallPrompts {
	confirm(question: string, defaultYes?: boolean): Promise<boolean>
}

/** Everything `runInstall` reaches the outside world through. */
export interface InstallCollaborators {
	readonly api: ZeropsApi
	readonly reconcileSchema: SchemaReconciler
	readonly sleep: Sleeper
	readonly log: InitLog
	readonly prompts: InstallPrompts
	readonly signal: AbortSignal
}

/** The project compute tier each installable platform tier requires. `corePackage` is upgrade-only. */
const REQUIRED_PROJECT_MODE: ZeropsProjectMode = 'LIGHT'

/** The private address the proxy dials IAM at inside the project, and pass 1's placeholder issuer. */
const PRIVATE_IAM_URL = 'http://iam:3000'

/** The canonical fabrika PostgreSQL DSN on Zerops — see `zerops/setups.ts` for why both suffixes exist. */
const POSTGRES_URL = '${db_connectionTlsString}/${db_dbName}?sslmode=require'

/** The light tier's one object-storage service, as the platform's own `${service_variable}` references. */
const STORAGE = {
	bucket: '${storage_bucketName}',
	accessKeyId: '${storage_accessKeyId}',
	secretAccessKey: '${storage_secretAccessKey}',
	endpoint: '${storage_apiUrl}',
} as const

/**
 * The three variables pass 1 writes on the proxy, and nothing else.
 *
 * The manifest is EMPTY on purpose: it is the only legal document that can be written before the hosts
 * exist, and the build bakes whatever is here (`zerops/setups.ts`). `FABRIKA_IAM_ISSUER` is the private
 * address rather than the public issuer for the same reason — the public one is not known yet — and
 * `deployPlatform` corrects it in pass 2, before the manifest it belongs to is applied.
 */
const passOneProxyEnv = (secrets: InstallationSecrets): ReadonlyMap<string, string> =>
	new Map([
		[FABRIKA_PROXY_MANIFEST_JSON, encodeProxyManifestJson({ apps: [] })],
		['FABRIKA_IAM_ISSUER', PRIVATE_IAM_URL],
		['FABRIKA_IAM_KEY', secrets.proxyKey],
	])

/** What `installationServiceEnv` needs. Everything in it is settled before the first write. */
export interface InstallationEnvInput {
	readonly projectId: string
	readonly environment: string
	readonly scheme: 'http' | 'https'
	readonly hosts: PlatformHosts
	readonly clientId: string
	readonly buildFromGit: string
	readonly apiBaseUrl?: string
	readonly secrets: InstallationSecrets
	/** The Zerops integration token minted for the control plane. Never logged, never printed. */
	readonly zeropsAccessToken: string
}

/**
 * EVERY variable this command places, per service.
 *
 * Pure, and exported, because the matrix is the thing most worth pinning: a name that is right on
 * Cloudflare and wrong on Bun is a silent no-op rather than a failure. Two spelling rules run through
 * it, both verified against the runtimes rather than assumed:
 *
 *   • IAM's Bun runtime reads `ISSUER` and `ENVIRONMENT` UNPREFIXED and everything else with the
 *     `FABRIKA_IAM_` prefix (`packages/iam/src/node/runtime.ts`). The prefixed spellings below are the
 *     ones that file actually reads; the unprefixed ones are the ones it actually reads too.
 *   • No key any service declares in its own `zerops.yaml` appears here — `PORT`,
 *     `FABRIKA_IAM_RPC_URL`, `FABRIKA_OPERATIONS_URL`, `FABRIKA_CONTROL_ASSETS_DIR`,
 *     `FABRIKA_CONTROL_URL`, `FABRIKA_ZEROPS_SOURCE_URL`, `FABRIKA_PROXY_MANIFEST`, `FABRIKA_PROXY_PORT`. The env API refuses those
 *     (`provider-zerops/src/api.ts`), because the conflict cannot be resolved to a record id.
 *
 * The proxy manifest is deliberately absent: pass 1 writes an empty one and `deployPlatform` owns the
 * real one, in the same run as the code it describes (ADR-0027).
 */
export const installationServiceEnv = (input: InstallationEnvInput): ReadonlyMap<PlatformDeployService, ReadonlyMap<string, string>> => {
	const { secrets } = input
	const iamOrigin = platformOrigin(input.scheme, input.hosts.iam)
	const consoleOrigin = platformOrigin(input.scheme, input.hosts.control)
	const operationsOrigin = platformOrigin(input.scheme, input.hosts.operations)
	const source = new Map([['FABRIKA_SOURCE_RPC_KEY', secrets.sourceRpcKey]])
	const control = new Map([
		['FABRIKA_CONTROL_DATABASE_URL', POSTGRES_URL],
		['ENVIRONMENT', input.environment],
		// A bare HOST, not an origin: `controlPublicOrigin` accepts either, and this is also what the
		// same-origin check on both first-party gateways is decided against.
		['FABRIKA_CONTROL_DOMAIN', input.hosts.control],
		['FABRIKA_IAM_ISSUER', iamOrigin],
		['OPERATIONS_ARTIFACT_ORIGIN', operationsOrigin],
		['FABRIKA_CONTROL_RUN_LOGS_BUCKET', STORAGE.bucket],
		['FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID', STORAGE.accessKeyId],
		['FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY', STORAGE.secretAccessKey],
		['FABRIKA_CONTROL_RUN_LOGS_ENDPOINT', STORAGE.endpoint],
		['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
		['OPERATIONS_SYNC_KEY', secrets.operationsSyncKey],
		['FABRIKA_CONTROL_VAULT_KEY', secrets.vaultKey],
		['FABRIKA_IAM_PROVISIONING_KEY', secrets.provisioningKey],
		['FABRIKA_ZEROPS_CLIENT_ID', input.clientId],
		['FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT', input.buildFromGit],
		// The PUBLIC IAM origin an application project's proxy reaches: there is no private network
		// between Zerops projects (ADR-0006).
		['FABRIKA_ZEROPS_PROXY_IAM_URL', iamOrigin],
		['FABRIKA_ZEROPS_PROXY_IAM_KEY', secrets.proxyKey],
		['FABRIKA_ZEROPS_ACCESS_TOKEN', input.zeropsAccessToken],
		['FABRIKA_ZEROPS_PROJECT_ID', input.projectId],
		['FABRIKA_ZEROPS_SOURCE_RPC_KEY', secrets.sourceRpcKey],
	])
	if (input.apiBaseUrl !== undefined) {
		// Only when the installation is not on the default region. Control spells it `_API_BASE_URL` while
		// the CLI reads `FABRIKA_ZEROPS_API_URL`; they are different processes reading different sources.
		control.set('FABRIKA_ZEROPS_API_BASE_URL', input.apiBaseUrl)
	}
	return new Map<PlatformDeployService, ReadonlyMap<string, string>>([
		[
			'iam',
			new Map([
				['FABRIKA_IAM_DATABASE_URL', POSTGRES_URL],
				['ENVIRONMENT', input.environment],
				['ISSUER', iamOrigin],
				['FABRIKA_IAM_ADMIN_ORIGINS', JSON.stringify([consoleOrigin])],
				// Password only, by decision: OIDC needs an identity provider the operator has not been
				// asked for. Both are STATED because IAM's own defaults are the other way round — OIDC on,
				// password off — and it refuses to boot with neither.
				['FABRIKA_IAM_OIDC_ENABLED', 'false'],
				['FABRIKA_IAM_PASSWORD_ENABLED', 'true'],
				['FABRIKA_IAM_SIGNING_KEYS', secrets.signingKeys],
				['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
				['FABRIKA_IAM_PROXY_KEY', secrets.proxyKey],
				['FABRIKA_IAM_PROVISIONING_KEY', secrets.provisioningKey],
			]),
		],
		[
			'operations',
			new Map([
				['FABRIKA_OPERATIONS_DATABASE_URL', POSTGRES_URL],
				['FABRIKA_OPERATIONS_BLOB_BUCKET', STORAGE.bucket],
				['FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID', STORAGE.accessKeyId],
				['FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY', STORAGE.secretAccessKey],
				['FABRIKA_OPERATIONS_BLOB_ENDPOINT', STORAGE.endpoint],
				['FABRIKA_OPERATIONS_PUBLIC_HOST', input.hosts.operations],
				['ENVIRONMENT', input.environment],
				['FABRIKA_IAM_ISSUER', iamOrigin],
				['OPERATIONS_SYNC_KEY', secrets.operationsSyncKey],
				['FABRIKA_IAM_RPC_KEY', secrets.rpcKey],
			]),
		],
		['source', source],
		['control', control],
		[
			'proxy',
			new Map([
				['ENVIRONMENT', input.environment],
				// Compared byte-for-byte against a token's `iss`, so this is the PUBLIC issuer and not the
				// private `iam:3000` pass 1 wrote.
				['FABRIKA_IAM_ISSUER', iamOrigin],
				['FABRIKA_IAM_KEY', secrets.proxyKey],
			]),
		],
	])
}

/**
 * The keys whose VALUE this command generates, per service.
 *
 * Their presence on a live service is what "this project already holds an installation" means, and it is
 * checked by KEY only — a value is never read back for comparison. `__tests__/install.test.ts` pins this
 * against the matrix above, so a new generated secret cannot be added without appearing here.
 */
export const GENERATED_SECRET_KEYS: ReadonlyMap<PlatformDeployService, readonly string[]> = new Map<PlatformDeployService, readonly string[]>([
	['iam', ['FABRIKA_IAM_SIGNING_KEYS', 'FABRIKA_IAM_RPC_KEY', 'FABRIKA_IAM_PROXY_KEY', 'FABRIKA_IAM_PROVISIONING_KEY']],
	['operations', ['OPERATIONS_SYNC_KEY', 'FABRIKA_IAM_RPC_KEY']],
	[
		'control',
		[
			'FABRIKA_IAM_RPC_KEY',
			'OPERATIONS_SYNC_KEY',
			'FABRIKA_CONTROL_VAULT_KEY',
			'FABRIKA_IAM_PROVISIONING_KEY',
			'FABRIKA_ZEROPS_PROXY_IAM_KEY',
			'FABRIKA_ZEROPS_ACCESS_TOKEN',
			'FABRIKA_ZEROPS_SOURCE_RPC_KEY',
		],
	],
	['source', ['FABRIKA_SOURCE_RPC_KEY']],
	['proxy', ['FABRIKA_IAM_KEY']],
])

const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new Error('the Zerops platform install was cancelled')
	}
}

/**
 * The services-only provisioning document (WU2), compiled from the declaration the committed artifact
 * is rendered from.
 *
 * Not read off disk: `gen:check` already proves
 * `zerops/generated/platform-light.services.provision.zerops-import.yaml` is this exact text, and a
 * value needs no filesystem in a published package.
 */
const provisioningDocument = (environment: string): CompiledDocument => {
	const compiled = compileTopology(platformTopology({ env: environment, tier: 'light', publicAccess: 'zerops-subdomain' }), environment)
	const document = compiled.servicesProvision
	if (document === undefined) {
		throw new Error('the light platform topology declares no services-only provisioning document')
	}
	return document
}

/** Read the operator's project and refuse anything the topology cannot be installed into. */
const resolveProject = async (
	input: PlatformInstallInput,
	{ api, log, signal }: InstallCollaborators,
): Promise<{ id: string; name: string }> => {
	const project = await api.getProject({ projectId: input.projectId, signal })
	if (project.id === '') {
		throw new Error(`Zerops project ${input.projectId} could not be read with this token`)
	}
	if (project.mode === undefined) {
		// Not a mismatch, so not a refusal: the client narrows an unknown value to absent, and blocking an
		// install on a field the API did not state would be refusing on an absence of evidence.
		log.warn(`Zerops did not state project ${project.name}'s mode; the ${input.tier} tier expects ${REQUIRED_PROJECT_MODE}`)
	} else if (project.mode !== REQUIRED_PROJECT_MODE) {
		throw new Error(
			`Zerops project ${project.name} is ${project.mode} and the ${input.tier} tier needs ${REQUIRED_PROJECT_MODE}. \`corePackage\` is `
				+ 'upgrade-only and its upgrade is partly destructive, so this is not something an install may change — create the project '
				+ `with core package ${REQUIRED_PROJECT_MODE}, or install a tier that matches`,
		)
	}
	return { id: project.id, name: project.name }
}

/** One service of the provisioning document that the project already has. */
interface ExistingService {
	readonly id: string
	readonly status?: ZeropsServiceStatus
}

/**
 * Every service of the provisioning document that the project already has, by hostname.
 *
 * The STATUS travels with the id because `NEW` is not a service this command may touch: measured live,
 * a service holds NO environment at all — not even the platform's generated keys — until it leaves that
 * state, so both a read and a write against one are meaningless rather than merely early.
 */
const existingServices = (declared: readonly string[], services: readonly ZeropsService[]): Map<string, ExistingService> => {
	const found = new Map<string, ExistingService>()
	for (const hostname of declared) {
		const matches = services.filter((service) => service.name === hostname)
		if (matches.length > 1) {
			throw new Error(`Zerops project has ${matches.length} services named \`${hostname}\``)
		}
		const match = matches[0]
		if (match !== undefined && match.id !== '') {
			found.set(hostname, { id: match.id, ...(match.status === undefined ? {} : { status: match.status }) })
		}
	}
	return found
}

/**
 * Refuse a service the platform is still creating.
 *
 * Not a wait: this command holds no process id for a service some earlier run imported, and a sleep
 * would be a guess at a number the platform never promised. The whole light topology settles in about a
 * minute, so "run it again shortly" is both true and cheap.
 */
const assertNoServiceIsBeingCreated = (existing: ReadonlyMap<string, ExistingService>): void => {
	const creating = [...existing].filter(([, service]) => service.status === 'NEW').map(([hostname]) => hostname)
	if (creating.length > 0) {
		throw new Error(
			`Zerops is still creating ${creating.join(', ')} — a service reads NEW with no environment at all, so nothing can be `
				+ 'read from it or written to it yet. The light topology settles in about a minute; run the install again then',
		)
	}
}

/**
 * Refuse a project that already carries this installation's generated secrets.
 *
 * By KEY, never by value. Re-running a bring-up would roll a fresh vault KEK — whose loss is
 * unrecoverable by design — and fresh signing keys, invalidating every live token, so the safe answer to
 * "was this already installed?" is to stop and say so. `platform deploy` is the command for an
 * installation that exists.
 */
const assertNotAlreadyInstalled = async (
	existing: ReadonlyMap<string, ExistingService>,
	collaborators: InstallCollaborators,
): Promise<void> => {
	const placed: string[] = []
	for (const hostname of PLATFORM_DEPLOY_ORDER) {
		const service = existing.get(hostname)
		if (service === undefined) {
			continue
		}
		const live = await readServiceEnv(service.id, collaborators)
		for (const key of GENERATED_SECRET_KEYS.get(hostname) ?? []) {
			if (live.has(key)) {
				placed.push(`${hostname}.${key}`)
			}
		}
	}
	if (placed.length > 0) {
		throw new Error(
			`this project already holds an installation — ${placed.join(', ')} ${placed.length === 1 ? 'is' : 'are'} already set. `
				+ '`platform install` is a BRING-UP and would roll a new vault key and new signing keys over them, which is unrecoverable '
				+ 'for the vault and logs everyone out. Use `fabrika platform deploy --provider=zerops` to update an installation',
		)
	}
}

/**
 * Import the topology, unless the project already has it.
 *
 * Three outcomes, and the middle one is the one that costs something to get wrong: re-applying a
 * `startWithoutCode: true` document at a service that carries code activates an EMPTY app version and
 * demotes the running one to `BACKUP` (`docs/reference/zerops-platform.md`). A PARTIAL set is refused
 * rather than completed, because an import applies as one document and cannot skip the services that
 * are already there.
 */
const provision = async (
	projectId: string,
	document: CompiledDocument,
	existing: ReadonlyMap<string, ExistingService>,
	collaborators: InstallCollaborators,
): Promise<void> => {
	const { api, log, prompts, sleep, signal } = collaborators
	const declared = document.document.services.map((service) => service.hostname)
	if (existing.size === declared.length) {
		log.info(`all ${declared.length} services already exist — skipping the import, which would activate an empty app version on each`)
		return
	}
	if (existing.size > 0) {
		const missing = declared.filter((hostname) => !existing.has(hostname))
		throw new Error(
			`Zerops project ${projectId} has ${[...existing.keys()].join(', ')} but not ${missing.join(', ')}. An import applies as ONE `
				+ 'document, so completing it would re-apply `startWithoutCode` at the services that already exist and activate an empty app '
				+ 'version on each. Create the missing services by hand, or start from an empty project',
		)
	}
	if (!(await prompts.confirm(`Import ${declared.length} services (${declared.join(', ')}) into project ${projectId}?`, true))) {
		throw new Error('declined: nothing has been created, and re-running the install is safe')
	}
	assertRunning(signal)
	const result: ZeropsImportResult = await api.importServices({ projectId, yaml: document.yaml, signal })
	const pending = result.services.flatMap((service) => service.processes.map((process) => ({ service: service.name, id: process.id })))
	log.ok(`imported ${result.services.length} service(s); waiting for ${pending.length} process(es)`)
	// WAIT BEFORE READING OR WRITING ANYTHING, and this is measured rather than careful.
	//
	// `importServices` returns immediately and the services are not usable yet. Live (2026-08-10, a
	// project created empty): the four runtime services read `status: NEW` with ZERO environment keys the
	// instant the call returned — not even the platform's own generated ones. The platform then creates
	// them SEQUENTIALLY in the document's `priority` order, ~15 s apart, and a service gains its ten
	// generated keys (`zeropsSubdomain` among them) only once it leaves `NEW`. So WU1's "zeropsSubdomain is
	// present before any deploy" is true, and true only after that transition.
	//
	// Waiting on every process id the import handed back is the mechanism; a sleep would be a guess at a
	// number the platform never promised. `waitForProcess`'s default budget is ~5 minutes per process
	// against a measured ~60 s for the whole light topology, which is the slack that measurement asks for.
	for (const process of pending) {
		await waitForProcess({ api, processId: process.id, sleep, signal, label: `the ${process.service} import` })
	}
	log.ok(`every import process finished (${pending.length})`)
}

/** Resolve the four platform services by hostname, naming the whole set that is missing rather than the first. */
const resolvePlatformServices = async (
	projectId: string,
	{ api, signal }: InstallCollaborators,
): Promise<Map<PlatformDeployService, ResolvedService>> => {
	const services = await api.listProjectServices({ projectId, signal })
	const resolved = new Map<PlatformDeployService, ResolvedService>()
	const missing: string[] = []
	for (const hostname of PLATFORM_DEPLOY_ORDER) {
		const match = services.find((service) => service.name === hostname)
		if (match === undefined || match.id === '') {
			missing.push(hostname)
			continue
		}
		resolved.set(hostname, { hostname, id: match.id })
	}
	if (missing.length > 0) {
		throw new Error(`Zerops project ${projectId} has no ${missing.join(', ')} service after provisioning`)
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

/**
 * Write a set of variables, reporting the KEYS — never a value, not even in a debug line.
 *
 * Write-first and unconditional: half of these are generated secrets, and a read-compare-write over a
 * value the platform may or may not hand back verbatim would make the outcome depend on something
 * nobody has pinned. `PUT /user-data/{id}` replaces in place, so a repeat costs a call and nothing else.
 */
const writeServiceEnv = async (
	service: ResolvedService,
	desired: ReadonlyMap<string, string>,
	{ api, log, signal }: InstallCollaborators,
): Promise<void> => {
	for (const [key, value] of desired) {
		assertRunning(signal)
		await api.putServiceEnv({ serviceId: service.id, key, value, signal })
	}
	log.ok(`${service.hostname}: wrote ${[...desired.keys()].join(', ')}`)
}

/**
 * Pass 1 — give the proxy its ports, so the installation has public hostnames.
 *
 * Returns the three derived hosts. `derivePlatformHosts` refuses to compose a hostname, so a proxy that
 * did not publish its six listeners fails here rather than producing a manifest pointing at an address
 * nobody answers.
 */
const passOne = async (
	input: PlatformInstallInput,
	proxy: ResolvedService,
	secrets: InstallationSecrets,
	collaborators: InstallCollaborators,
): Promise<PlatformHosts> => {
	const { log, prompts } = collaborators
	log.step('Pass 1 — build the proxy so the installation has public hostnames')
	log.info('An empty manifest is a legal one: the proxy comes up answering 404 and publishes one hostname per HTTP port.')
	if (!(await prompts.confirm(`Write 3 variables on \`proxy\` and build it from ${input.buildFromGit}? (about 4 minutes)`, true))) {
		throw new Error('declined: no variable was written, and re-running the install is safe')
	}
	await writeServiceEnv(proxy, passOneProxyEnv(secrets), collaborators)
	await deployPlatformService(proxy, { buildFromGit: input.buildFromGit, dryRun: false }, collaborators)

	const proxyEnv = await readServiceEnv(proxy.id, collaborators)
	const subdomains = proxyEnv.get(ZEROPS_SUBDOMAIN_VARIABLE)
	if (subdomains === undefined || subdomains.trim() === '') {
		throw new Error('the proxy published no Zerops subdomain after its first deploy — this installation has no address to be named by')
	}
	const listeners = PLATFORM_PROXY_MANIFEST_TEMPLATE.apps.map((app) => ({ service: app.service, port: app.port }))
	return derivePlatformHosts(subdomains, listeners)
}

/**
 * Bring up one Zerops platform installation from a project the operator created empty.
 *
 * Every step that leaves this machine is confirmed first, and declining any of them stops there with
 * what to run instead. Nothing before the import is a mutation, so a declined install leaves the project
 * exactly as it was.
 */
export const runInstall = async (input: PlatformInstallInput, collaborators: InstallCollaborators): Promise<void> => {
	const { log, prompts, signal } = collaborators
	assertRunning(signal)
	// Refused HERE, before anything is contacted: `local` is the name every development bypass is gated
	// on, and IAM and control both refuse to boot with it on a public origin.
	const environment = checkedEnvironmentName(input.environment)

	log.info(`fabrika platform install — the ${environment} Zerops installation, on the ${input.tier} tier`)
	log.info('This CREATES an installation. It generates every credential it needs and prints one of them at the end.')

	log.step('Resolve the project the operator created')
	// One confirmation covers every READ this step makes — the project, its services, and which variable
	// KEYS those services already carry. None of them changes anything.
	if (!(await prompts.confirm(`Read Zerops project ${input.projectId} and its services? (the token, the id, the core package, what exists)`, true))) {
		throw new Error('declined: nothing was contacted, and re-running the install is safe')
	}
	const project = await resolveProject(input, collaborators)
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
		'IAM signing keys (1 × ES256), the IAM RPC key, the source RPC key, the proxy key, the provisioning key, the Operations sync key and the vault key',
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
	})
	if (token.token === '') {
		throw new Error('Zerops minted an integration token with no value — the control plane cannot deploy anything without one')
	}
	log.ok(`integration token ${token.id} minted, ${token.projects.length} project grant(s)`)

	const hosts = await passOne(input, serviceOf(services, PLATFORM_PROXY_SERVICE), secrets, collaborators)
	log.ok(`iam ${hosts.iam}`)
	log.ok(`console ${hosts.control}`)
	log.ok(`operations ${hosts.operations}`)

	log.step('Write every remaining variable')
	const desired = installationServiceEnv({
		projectId: input.projectId,
		environment,
		scheme: input.scheme,
		hosts,
		clientId: input.clientId,
		buildFromGit: input.buildFromGit,
		secrets,
		zeropsAccessToken: token.token,
		...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl }),
	})
	const total = [...desired.values()].reduce((sum, keys) => sum + keys.size, 0)
	if (!(await prompts.confirm(`Write ${total} variables across ${desired.size} services?`, true))) {
		throw new Error('declined: the proxy is built but the installation is not configured; re-running the install is safe')
	}
	for (const hostname of PLATFORM_DEPLOY_ORDER) {
		await writeServiceEnv(serviceOf(services, hostname), desired.get(hostname) ?? new Map<string, string>(), collaborators)
	}

	log.step('Pass 2 — deploy the installation')
	log.info(`\`platform deploy\` owns the whole ordered sequence: ${PLATFORM_DEPLOY_ORDER.join(' → ')}, the proxy ahead of control (ADR-0027).`)
	if (!(await prompts.confirm('Deploy the installation now? (about 15 minutes)', true))) {
		log.action('OPERATOR ACTION — every variable is placed; the installation is one command from running', [
			`FABRIKA_ZEROPS_ACCESS_TOKEN=… FABRIKA_IAM_PROVISIONING_KEY=… fabrika platform deploy --provider=zerops --project-id=${project.id} --env=${environment}`,
		])
	} else {
		await deployPlatform({
			project: { kind: 'id', projectId: project.id },
			accessToken: input.accessToken,
			environment,
			scheme: input.scheme,
			buildFromGit: input.buildFromGit,
			iamAdminKey: secrets.provisioningKey,
			dryRun: false,
			...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: input.apiBaseUrl }),
		}, collaborators)
	}

	log.step('Hand off')
	// THE ONE INTENTIONAL EXCEPTION to "never log a secret value", and the reason it exists: this key is
	// stored nowhere — there is no `.env` on the Zerops path — and `platform init` cannot invent it,
	// because IAM would not admit a value it was not seeded with. Printed once, at the end, in a box.
	log.action('CAPTURE THIS NOW — it is stored nowhere else and cannot be recovered', [
		`FABRIKA_IAM_PROVISIONING_KEY=${secrets.provisioningKey}`,
	])
	log.info('`fabrika platform init --provider=zerops <installation>` asks for two required deployment secrets:')
	log.info('  FABRIKA_IAM_PROVISIONING_KEY   the key above')
	log.info('  FABRIKA_ZEROPS_ACCESS_TOKEN    the integration token just minted — read it back from the `control` service, never printed here')
	log.info(`The console answers at ${platformOrigin(input.scheme, hosts.control)}, once someone can sign in: nobody can yet.`)
}

/**
 * How this command's confirmations are answered — and the refusal when nothing can answer them.
 *
 * The confirmations are the only thing standing between a stray invocation and an installation: this
 * command generates seven credentials, mints a Zerops token on the account and deploys. Every one of
 * them defaults to yes, so a pipe carrying blank lines answers all six of them with nobody reading
 * what they agree to. So a run with no terminal is refused unless the operator asked for it by name.
 */
export const installPrompts = (
	input: PlatformInstallInput,
	stdin: { readonly isTTY?: boolean },
	announce: (line: string) => void,
): InstallPrompts => {
	if (input.unattended) {
		// The flag IS the yes, given once for the whole sequence; nothing reads stdin after it. Each
		// question is still printed with the answer it was given, so an unattended run leaves the same
		// record of what was agreed to that an interactive one does.
		return {
			confirm: (question) => {
				announce(`${question} yes (${UNATTENDED_FLAG})`)
				return Promise.resolve(true)
			},
		}
	}
	if (stdin.isTTY !== true) {
		throw new Error(
			"stdin is not a terminal, so nobody is here to confirm what this command does — it generates this installation's "
				+ 'credentials, mints a Zerops integration token and deploys. Run it from a terminal, or pass `'
				+ UNATTENDED_FLAG
				+ '` to answer every confirmation yes unattended',
		)
	}
	return { confirm: (question, defaultYes) => promptConfirm(question, defaultYes) }
}

/** The real collaborators: a TTY for the confirmations, the Zerops API, and IAM's own schema reconciler. */
export const consoleInstallCollaborators = (input: PlatformInstallInput, reconcileSchema: SchemaReconciler): InstallCollaborators => {
	// First, before anything is built or contacted: a bring-up nobody can confirm does not start.
	const prompts = installPrompts(input, process.stdin, (line) => consoleInfo(line))
	return {
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
