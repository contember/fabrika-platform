import { ENV_ISOLATION, renderYaml, type ZeropsProjectMode, type ZeropsProjectStatus } from '../index'
import { assertRunning, type InstallCollaborators } from './install-collaborators'
import type { PlatformInstallInput } from './install-options'
import { installationTopology } from './install-provisioning'
import { assertPersonalAccessToken } from './install-token'
import type { PlatformTier } from './topology/topology'

/** The project compute tier each platform tier requires. `corePackage` is upgrade-only. */
const REQUIRED_PROJECT_MODE: Readonly<Record<PlatformTier, ZeropsProjectMode>> = { light: 'LIGHT', standard: 'SERIOUS' }

/** The one project state this command may install into. */
const PROJECT_ACTIVE: ZeropsProjectStatus = 'ACTIVE'

/**
 * Project states a bring-up cannot come back from, so waiting them out is only a slower failure.
 *
 * `NEW`, `CREATING` and `STARTING` are on the way to `ACTIVE` and are waited on; so is a status this
 * build has never seen, which can therefore cost time and never be read as success. These four are the
 * other direction, and the message must NOT offer `--project-id`: resuming into a `FAILED` or `DELETING`
 * project installs nothing.
 */
const PROJECT_UNUSABLE: ReadonlySet<ZeropsProjectStatus> = new Set<ZeropsProjectStatus>(['FAILED', 'DELETING', 'STOPPING', 'STOPPED'])

/** Live-measured: a created project reads `NEW` at t+1 s and `ACTIVE` at about t+20 s. */
const PROJECT_POLL_INTERVAL_MS = 2_000

/** The number of SLEEPS, so the wait is 60 × 2 s = two minutes spread between 61 reads. */
const PROJECT_POLL_ATTEMPTS = (2 * 60_000) / PROJECT_POLL_INTERVAL_MS

/** Consecutive `getProject` failures ridden out before the wait gives the run back to the operator. */
const PROJECT_READ_FAILURES = 3

/**
 * The document `--create-project` applies, carrying a `project:` block and NO services.
 *
 * Taken from the same declaration the provisioning import is compiled from, so `envIsolation: service`
 * and `corePackage` — the two settings a project accepts at CREATION only and never afterwards —
 * have exactly one source. Only the name is this run's. `renderImportYaml` is not the renderer here
 * because it refuses a document with no services, and this one deliberately has none: the services arrive
 * through the services-only import, into the project this creates.
 */
const createProjectYaml = (environment: string, tier: PlatformTier, projectName: string): string => {
	const declared = installationTopology(environment, tier).provision.document.project
	const mode = REQUIRED_PROJECT_MODE[tier]
	if (declared === undefined || declared.corePackage !== mode || declared.envIsolation !== ENV_ISOLATION) {
		throw new Error(`the ${tier} platform topology declares no \`${mode}\` project with \`envIsolation: ${ENV_ISOLATION}\` to create`)
	}
	return renderYaml({ project: { ...declared, name: projectName }, services: [] })
}

/** One poll of the created project: its status, or the failure the read itself ended in. */
type ProjectRead =
	| { readonly ok: true; readonly status: ZeropsProjectStatus | undefined }
	| { readonly ok: false; readonly failure: unknown }

/**
 * Wait for a created project to be `ACTIVE`.
 *
 * Live-measured (2026-08-21): the import answers in about a second and the project then reads `NEW` →
 * `CREATING` → `ACTIVE` at about t+20 s. Whether a service import into a `CREATING` project succeeds is
 * NOT measured, so this waits rather than finds out.
 *
 * Three outcomes, and the difference between them is what the operator is told to do next. `ACTIVE`
 * returns. A state in `PROJECT_UNUSABLE` throws WITHOUT a resume hint, because the project is spent. A
 * transient state, an unknown one, or a read that fails outright is waited out — a 5xx on the read says
 * nothing about the project, so a few in a row are ridden out before the run is handed back, and it is
 * handed back with the id, because by then a project exists that the operator would otherwise leak.
 */
const waitForProjectActive = async (projectId: string, { api, sleep, signal }: InstallCollaborators): Promise<void> => {
	let failures = 0
	let last: ZeropsProjectStatus | 'unreadable' | undefined
	for (let attempt = 0;; attempt += 1) {
		assertRunning(signal)
		const read: ProjectRead = await api.getProject({ projectId, signal }).then(
			(project): ProjectRead => ({ ok: true, status: project.status }),
			(failure: unknown): ProjectRead => ({ ok: false, failure }),
		)
		if (!read.ok) {
			failures += 1
			last = 'unreadable'
			if (failures > PROJECT_READ_FAILURES) {
				throw new Error(
					`Zerops project ${projectId} was created but could not be read ${failures} times in a row. Re-run the install with `
						+ `--project-id=${projectId} instead of --create-project`,
					{ cause: read.failure },
				)
			}
		} else {
			failures = 0
			last = read.status
			if (read.status === PROJECT_ACTIVE) {
				return
			}
			if (read.status !== undefined && PROJECT_UNUSABLE.has(read.status)) {
				throw new Error(
					`Zerops project ${projectId} reads \`${read.status}\`, which a bring-up cannot recover from: the project exists and nothing `
						+ 'can be installed into it. Delete it and run the install again — do NOT resume into this one',
				)
			}
		}
		if (attempt >= PROJECT_POLL_ATTEMPTS) {
			throw new Error(
				`Zerops project ${projectId} still reads \`${last ?? 'no status'}\` after two minutes (${PROJECT_POLL_ATTEMPTS + 1} reads, `
					+ `${PROJECT_POLL_INTERVAL_MS / 1_000} s apart). It exists and may yet settle — re-run the install with `
					+ `--project-id=${projectId} instead of --create-project`,
			)
		}
		await sleep(PROJECT_POLL_INTERVAL_MS, signal)
	}
}

/**
 * Create the project this installation is brought up in, and wait for it to be usable.
 *
 * The id is reported BEFORE the wait, and that ordering is the whole point of the line: an interrupted
 * run has already spent a project on the account, and this id is the only way back to it.
 */
const createProject = async (
	input: PlatformInstallInput,
	environment: string,
	projectName: string,
	collaborators: InstallCollaborators,
): Promise<string> => {
	const { api, log, signal } = collaborators
	assertRunning(signal)
	const result = await api.importProject({
		clientId: input.clientId,
		yaml: createProjectYaml(environment, input.tier, projectName),
		signal,
	})
	if (result.projectId === '') {
		throw new Error(`Zerops created a project named ${projectName} with no id — nothing can be installed into it`)
	}
	log.ok(
		`created Zerops project ${result.projectId} (${result.projectName ?? projectName}) — resume with --project-id=${result.projectId} if this `
			+ 'run is interrupted',
	)
	await waitForProjectActive(result.projectId, collaborators)
	return result.projectId
}

/** Read the project and refuse anything the topology cannot be installed into. */
const resolveProject = async (
	input: PlatformInstallInput,
	projectId: string,
	{ api, log, signal }: InstallCollaborators,
): Promise<{ id: string; name: string }> => {
	const project = await api.getProject({ projectId, signal })
	const mode = REQUIRED_PROJECT_MODE[input.tier]
	if (project.id === '') {
		throw new Error(`Zerops project ${projectId} could not be read with this token`)
	}
	if (project.mode === undefined) {
		// Not a mismatch, so not a refusal: the client narrows an unknown value to absent, and blocking an
		// install on a field the API did not state would be refusing on an absence of evidence.
		log.warn(`Zerops did not state project ${project.name}'s mode; the ${input.tier} tier expects ${mode}`)
	} else if (project.mode !== mode) {
		throw new Error(
			`Zerops project ${project.name} is ${project.mode} and the ${input.tier} tier needs ${mode}. \`corePackage\` is `
				+ 'upgrade-only and its upgrade is partly destructive, so this is not something an install may change — create the project '
				+ `with core package ${mode}, or install a tier that matches`,
		)
	}
	return { id: project.id, name: project.name }
}

/**
 * Settle which project this run installs into — the operator's, or one created here.
 *
 * ONE confirmation either way, and both cover the token check and the read that follows: a created project is read back
 * through the same `resolveProject` an operator-made one goes through, so the core package is checked on
 * the project that will actually be installed into rather than on the document that asked for it.
 */
export const resolveInstallationProject = async (
	input: PlatformInstallInput,
	environment: string,
	collaborators: InstallCollaborators,
): Promise<{ id: string; name: string }> => {
	const { log, prompts } = collaborators
	const source = input.project
	if (source.kind === 'existing') {
		log.step('Resolve the project the operator created')
		// One confirmation covers every READ this step makes — the project, its services, and which variable
		// KEYS those services already carry. None of them changes anything.
		if (
			!(await prompts.confirm(`Read Zerops project ${source.projectId} and its services? (the token, the id, the core package, what exists)`, true))
		) {
			throw new Error('declined: nothing was contacted, and re-running the install is safe')
		}
		await assertPersonalAccessToken(collaborators)
		return resolveProject(input, source.projectId, collaborators)
	}
	log.step('Create the project this installation is brought up in')
	log.info('`envIsolation` and `corePackage` are settable at project CREATION only, which is why the project is created from here.')
	if (
		!(await prompts.confirm(
			`Check the token, then CREATE Zerops project \`${source.projectName}\` (core package ${
				REQUIRED_PROJECT_MODE[input.tier]
			}, envIsolation ${ENV_ISOLATION}) on client `
				+ `${input.clientId}, then read it back?`,
			true,
		))
	) {
		throw new Error('declined: no project was created, and re-running the install is safe')
	}
	await assertPersonalAccessToken(collaborators)
	const projectId = await createProject(input, environment, source.projectName, collaborators)
	return resolveProject(input, projectId, collaborators)
}
