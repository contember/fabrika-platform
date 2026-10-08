import { waitForProcess, type ZeropsImportResult, type ZeropsService, type ZeropsServiceStatus } from '@fabrika/provider-zerops'
import { PLATFORM_DEPLOY_ORDER, type PlatformDeployService, readServiceEnv, type ResolvedService } from './deploy'
import { assertRunning, type InstallCollaborators } from './install-collaborators'
import { GENERATED_SECRET_KEYS } from './install-environment'
import { type CompiledDocument, type CompiledTopology, compileTopology, platformTopology } from './topology/topology'

/** The one topology this command installs, so the project document and the services document cannot drift. */
export const lightTopology = (environment: string): CompiledTopology =>
	compileTopology(platformTopology({ env: environment, tier: 'light', publicAccess: 'zerops-subdomain' }), environment)

/**
 * The services-only provisioning document (WU2), compiled from the declaration the committed artifact
 * is rendered from.
 *
 * Not read off disk: `gen:check` already proves
 * `packages/platform-artifacts/generated/platform-light.services.provision.zerops-import.yaml` is this exact text, and a
 * value needs no filesystem in a published package.
 */
export const provisioningDocument = (environment: string): CompiledDocument => {
	const document = lightTopology(environment).servicesProvision
	if (document === undefined) {
		throw new Error('the light platform topology declares no services-only provisioning document')
	}
	return document
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
export const existingServices = (declared: readonly string[], services: readonly ZeropsService[]): Map<string, ExistingService> => {
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
export const assertNoServiceIsBeingCreated = (existing: ReadonlyMap<string, ExistingService>): void => {
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
export const assertNotAlreadyInstalled = async (
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
			`this project already holds an installation's generated secrets — ${placed.join(', ')} ${placed.length === 1 ? 'is' : 'are'} already set. `
				+ '`platform install` is a BRING-UP and would roll a new vault key and new signing keys over them, which is unrecoverable '
				+ 'for the vault and logs everyone out. If every bootstrap variable was placed, use `fabrika platform deploy --provider=zerops` '
				+ 'to update or finish deploying the installation; recover FABRIKA_IAM_PROVISIONING_KEY from `iam` or `control` and '
				+ 'FABRIKA_ZEROPS_ACCESS_TOKEN from `control` in Zerops. Neither deploy nor init completes a partial bootstrap. '
				+ 'For partial bootstrap, preserve the existing keys and arrange operator-owned recovery, or start a fresh installation in a separate empty project',
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
export const provision = async (
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
export const resolvePlatformServices = async (
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

export { serviceOf } from './deploy'
