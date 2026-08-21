interface ProjectRecord {
	id: string
	clientId: string
	name: string
	status: 'ACTIVE'
	mode: 'LIGHT' | 'SERIOUS'
	description?: string
	tagList?: string[]
}

interface ServiceRecord {
	id: string
	projectId: string
	name: string
	status: 'ACTIVE'
	base?: string
	activeAppVersionId?: string
	subdomainAccess?: boolean
	autoscalingProfileId?: string
}

interface ServiceEnvRecord {
	id: string
	serviceStackId: string
	key: string
	content: string
	type: 'SECRET'
}

interface AppVersionRecord {
	id: string
	serviceStackId: string
	projectId: string
	status: 'BUILDING' | 'ACTIVE' | 'CANCELLED'
	sequence: number
	activateAt?: number
}

/**
 * One asynchronous platform operation.
 *
 * `pendingReads` is how many more `GET /process/{id}` calls answer `PENDING` before the process reports
 * `FINISHED`; it starts at 1. Handing back `FINISHED` on the first read would be simpler, but then a
 * caller that never polls passes here and hangs on the platform — proving the wait runs is the only
 * reason to double a process at all. One PENDING read is enough to make the loop turn without making the
 * local stack sleep through every bring-up.
 */
interface ProcessRecord {
	id: string
	actionName: string
	serviceStackId?: string
	/** Only a `stack.delete` process carries one live; nothing else here sets it. */
	projectId?: string
	appVersionId?: string
	pendingReads: number
}

/** The tiered access role shared by an integration token's request and its response. */
type RoleCode = 'OWNER' | 'ADMIN' | 'BASIC_USER' | 'READ_ONLY' | 'NO_ACCESS'

/** One project grant carried by an integration token. `roleCode` is echoed, never defaulted — see `readGrant`. */
interface TokenGrantRecord {
	projectId: string
	roleCode?: RoleCode
}

/**
 * One minted integration token, MINUS its value: the double derives that from the id
 * (`fakeIntegrationTokenValue`) so nothing credential-shaped is ever written to the state file or served
 * by `/__local/state`.
 */
interface IntegrationTokenRecord {
	id: string
	clientId: string
	name: string
	created: string
	lastUpdate: string
	projects: TokenGrantRecord[]
	roleCode?: RoleCode
}

interface EmulatorSnapshot {
	nextProject: number
	nextService: number
	nextEnv: number
	nextVersion: number
	nextProcess: number
	nextIntegrationToken: number
	projects: ProjectRecord[]
	services: ServiceRecord[]
	serviceEnv: ServiceEnvRecord[]
	appVersions: AppVersionRecord[]
	processes: ProcessRecord[]
	integrationTokens: IntegrationTokenRecord[]
}

/**
 * `enableSubdomainAccess` is deliberately ABSENT. The real platform accepts the field in an import and
 * silently drops it — on a service the document creates as much as on one it overrides — so a double that
 * honoured it would let a broken provisioning path pass here and fail on an account
 * (`docs/reference/zerops-platform.md`). The subdomain is established by `enable-subdomain-access` only.
 */
interface ImportService {
	hostname: string
	type?: string
	profile?: string
	/** Without it the platform refuses a name that already exists — the WHOLE document, not just the entry. */
	override?: boolean
	zeropsSetup?: string
	buildFromGit?: string
}

/** What one entry of an import document did. `process` is absent when the service was already there. */
interface ImportOutcome {
	service: ServiceRecord
	process?: ProcessRecord
}

interface ImportDocument {
	project?: {
		name: string
		corePackage?: string
		description?: string
		tags?: string[]
	}
	services: ImportService[]
}

export interface ZeropsEmulatorOptions {
	token: string
	stateFile?: string
	activationDelayMs?: number
	now?: () => number
}

const emptySnapshot = (): EmulatorSnapshot => ({
	nextProject: 1,
	nextService: 1,
	nextEnv: 1,
	nextVersion: 1,
	nextProcess: 1,
	nextIntegrationToken: 1,
	projects: [],
	services: [],
	serviceEnv: [],
	appVersions: [],
	processes: [],
	integrationTokens: [],
})

const property = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined

const stringProperty = (value: unknown, key: string): string | undefined => {
	const found = property(value, key)
	return typeof found === 'string' ? found : undefined
}

const booleanProperty = (value: unknown, key: string): boolean | undefined => {
	const found = property(value, key)
	return typeof found === 'boolean' ? found : undefined
}

const numberProperty = (value: unknown, key: string): number | undefined => {
	const found = property(value, key)
	return typeof found === 'number' ? found : undefined
}

const stringArrayProperty = (value: unknown, key: string): string[] | undefined => {
	const found = property(value, key)
	if (!Array.isArray(found) || found.some((entry) => typeof entry !== 'string')) {
		return undefined
	}
	return found.filter((entry): entry is string => typeof entry === 'string')
}

const parseImportDocument = (yaml: string): ImportDocument => {
	const value: unknown = Bun.YAML.parse(yaml)
	const rawServices = property(value, 'services')
	if (!Array.isArray(rawServices) || rawServices.length === 0) {
		throw new Error('import must declare at least one service')
	}
	const services = rawServices.map((entry): ImportService => {
		const hostname = stringProperty(entry, 'hostname')
		if (hostname === undefined || hostname === '') {
			throw new Error('every imported service must have a hostname')
		}
		const zeropsSetup = stringProperty(entry, 'zeropsSetup')
		const buildFromGit = stringProperty(entry, 'buildFromGit')
		// A `zeropsSetup` names a pipeline config, and the platform takes one only beside a build source.
		if (zeropsSetup !== undefined && buildFromGit === undefined) {
			throw new PlatformRefusal(400, 'projectImportInvalidParameter', 'parameter is required for use of pipelineConfig')
		}
		return {
			hostname,
			...(stringProperty(entry, 'type') === undefined ? {} : { type: stringProperty(entry, 'type') }),
			...(stringProperty(entry, 'profile') === undefined ? {} : { profile: stringProperty(entry, 'profile') }),
			...(booleanProperty(entry, 'override') === undefined ? {} : { override: booleanProperty(entry, 'override') }),
			...(zeropsSetup === undefined ? {} : { zeropsSetup }),
			...(buildFromGit === undefined ? {} : { buildFromGit }),
		}
	})
	const rawProject = property(value, 'project')
	if (rawProject === undefined) {
		return { services }
	}
	const name = stringProperty(rawProject, 'name')
	if (name === undefined || name === '') {
		throw new Error('an imported project must have a name')
	}
	return {
		project: {
			name,
			...(stringProperty(rawProject, 'corePackage') === undefined ? {} : { corePackage: stringProperty(rawProject, 'corePackage') }),
			...(stringProperty(rawProject, 'description') === undefined ? {} : { description: stringProperty(rawProject, 'description') }),
			...(stringArrayProperty(rawProject, 'tags') === undefined ? {} : { tags: stringArrayProperty(rawProject, 'tags') }),
		},
		services,
	}
}

/**
 * A refusal the platform states with its own error code. `route`'s catch-all answers `400 BAD_REQUEST`,
 * which is honest for a malformed request and useless for a fact a client branches on.
 */
class PlatformRefusal extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message)
		this.name = 'PlatformRefusal'
	}
}

const parseJsonBody = async (request: Request): Promise<unknown> => {
	try {
		return await request.json()
	} catch {
		throw new Error('request body must be JSON')
	}
}

const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status)

/** The one answer the whole service-stack family gives for "absent", whatever the reason. */
const serviceStackNotFound = (): Response => error(400, 'serviceStackNotFound', 'Service stack not found.')

/** The refusal every user-data write gets without `sensitive`, create and update alike. */
const sensitiveIsRequired = (): Response => error(400, 'invalidUserInput', 'sensitive: field is required')

/** Zerops owns this key prefix and refuses a custom variable that uses it. */
const RESERVED_KEY_PREFIX = 'ZEROPS_'

const id = (prefix: string, sequence: number): string => `${prefix}-${sequence.toString().padStart(6, '0')}`

const readSnapshot = async (path: string | undefined): Promise<EmulatorSnapshot> => {
	if (path === undefined || !(await Bun.file(path).exists())) {
		return emptySnapshot()
	}
	const value: unknown = await Bun.file(path).json()
	const counters = ['nextProject', 'nextService', 'nextEnv', 'nextVersion', 'nextProcess']
	const arrays = ['projects', 'services', 'serviceEnv', 'appVersions']
	// Processes and integration tokens arrived after the first state files were written; a file that
	// predates them simply has none, and refusing it would cost a `local:reset` for no reader's benefit.
	const laterArrays = ['processes', 'integrationTokens']
	if (
		typeof value !== 'object'
		|| value === null
		|| counters.some((key) => typeof property(value, key) !== 'number')
		|| arrays.some((key) => !Array.isArray(property(value, key)))
		|| laterArrays.some((key) => property(value, key) !== undefined && !Array.isArray(property(value, key)))
	) {
		throw new Error('invalid Zerops emulator state file')
	}
	const projects = property(value, 'projects')
	const services = property(value, 'services')
	const serviceEnv = property(value, 'serviceEnv')
	const appVersions = property(value, 'appVersions')
	if (!Array.isArray(projects) || !Array.isArray(services) || !Array.isArray(serviceEnv) || !Array.isArray(appVersions)) {
		throw new Error('invalid Zerops emulator state arrays')
	}
	return {
		nextProject: readCounter(value, 'nextProject'),
		nextService: readCounter(value, 'nextService'),
		nextEnv: readCounter(value, 'nextEnv'),
		nextVersion: readCounter(value, 'nextVersion'),
		nextProcess: readCounter(value, 'nextProcess'),
		nextIntegrationToken: property(value, 'nextIntegrationToken') === undefined ? 1 : readCounter(value, 'nextIntegrationToken'),
		projects: projects.map(readProjectRecord),
		services: services.map(readServiceRecord),
		serviceEnv: serviceEnv.map(readServiceEnvRecord),
		appVersions: appVersions.map(readAppVersionRecord),
		processes: laterArray(value, 'processes').map(readProcessRecord),
		integrationTokens: laterArray(value, 'integrationTokens').map(readIntegrationTokenRecord),
	}
}

const laterArray = (value: unknown, key: string): unknown[] => {
	const found = property(value, key)
	return Array.isArray(found) ? found : []
}

const requiredString = (value: unknown, key: string): string => {
	const found = stringProperty(value, key)
	if (found === undefined) {
		throw new Error(`invalid state field ${key}`)
	}
	return found
}

const readCounter = (value: unknown, key: string): number => {
	const found = property(value, key)
	if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
		throw new Error(`invalid state counter ${key}`)
	}
	return found
}

const readProjectRecord = (value: unknown): ProjectRecord => {
	const mode = stringProperty(value, 'mode')
	if (mode !== 'LIGHT' && mode !== 'SERIOUS') {
		throw new Error('invalid project mode in state')
	}
	return {
		id: requiredString(value, 'id'),
		clientId: requiredString(value, 'clientId'),
		name: requiredString(value, 'name'),
		status: 'ACTIVE',
		mode,
		...(stringProperty(value, 'description') === undefined ? {} : { description: stringProperty(value, 'description') }),
		...(stringArrayProperty(value, 'tagList') === undefined ? {} : { tagList: stringArrayProperty(value, 'tagList') }),
	}
}

const readServiceRecord = (value: unknown): ServiceRecord => ({
	id: requiredString(value, 'id'),
	projectId: requiredString(value, 'projectId'),
	name: requiredString(value, 'name'),
	status: 'ACTIVE',
	...(stringProperty(value, 'base') === undefined ? {} : { base: stringProperty(value, 'base') }),
	...(stringProperty(value, 'activeAppVersionId') === undefined
		? {}
		: { activeAppVersionId: stringProperty(value, 'activeAppVersionId') }),
	...(booleanProperty(value, 'subdomainAccess') === undefined
		? {}
		: { subdomainAccess: booleanProperty(value, 'subdomainAccess') }),
	...(stringProperty(value, 'autoscalingProfileId') === undefined
		? {}
		: { autoscalingProfileId: stringProperty(value, 'autoscalingProfileId') }),
})

const readServiceEnvRecord = (value: unknown): ServiceEnvRecord => ({
	id: requiredString(value, 'id'),
	serviceStackId: requiredString(value, 'serviceStackId'),
	key: requiredString(value, 'key'),
	content: requiredString(value, 'content'),
	type: 'SECRET',
})

const readAppVersionRecord = (value: unknown): AppVersionRecord => {
	const status = stringProperty(value, 'status')
	if (status !== 'BUILDING' && status !== 'ACTIVE' && status !== 'CANCELLED') {
		throw new Error('invalid app-version status in state')
	}
	const activateAt = numberProperty(value, 'activateAt')
	if (activateAt !== undefined && (!Number.isFinite(activateAt) || activateAt < 0)) {
		throw new Error('invalid app-version activation time in state')
	}
	return {
		id: requiredString(value, 'id'),
		serviceStackId: requiredString(value, 'serviceStackId'),
		projectId: requiredString(value, 'projectId'),
		status,
		sequence: readCounter(value, 'sequence'),
		...(activateAt === undefined ? {} : { activateAt }),
	}
}

const readProcessRecord = (value: unknown): ProcessRecord => {
	const pendingReads = numberProperty(value, 'pendingReads')
	if (pendingReads === undefined || !Number.isInteger(pendingReads) || pendingReads < 0) {
		throw new Error('invalid process pending-read count in state')
	}
	return {
		id: requiredString(value, 'id'),
		actionName: requiredString(value, 'actionName'),
		pendingReads,
		...(stringProperty(value, 'serviceStackId') === undefined ? {} : { serviceStackId: stringProperty(value, 'serviceStackId') }),
		...(stringProperty(value, 'projectId') === undefined ? {} : { projectId: stringProperty(value, 'projectId') }),
		...(stringProperty(value, 'appVersionId') === undefined ? {} : { appVersionId: stringProperty(value, 'appVersionId') }),
	}
}

const ROLE_CODES: readonly RoleCode[] = ['OWNER', 'ADMIN', 'BASIC_USER', 'READ_ONLY', 'NO_ACCESS']

/** A role this double does not know is refused, never silently downgraded. */
const asRoleCode = (value: unknown, context: string): RoleCode => {
	const roleCode = ROLE_CODES.find((role) => role === value)
	if (roleCode === undefined) {
		throw new Error(`unknown roleCode in ${context}`)
	}
	return roleCode
}

/**
 * One project grant, read the same way from a request body and from the state file.
 *
 * An ABSENT `roleCode` is carried through as absent rather than filled in with the schema's documented
 * `NO_ACCESS` default: the client refuses to guess a grant it was not told about, and a double that
 * invented one would hide exactly that.
 */
const readGrant = (value: unknown): TokenGrantRecord => {
	const projectId = requiredString(value, 'projectId')
	const raw = property(value, 'roleCode')
	return raw === undefined ? { projectId } : { projectId, roleCode: asRoleCode(raw, `the integration token grant for ${projectId}`) }
}

const readIntegrationTokenRecord = (value: unknown): IntegrationTokenRecord => {
	const projects = property(value, 'projects')
	if (!Array.isArray(projects)) {
		throw new Error('invalid integration token grants in state')
	}
	const roleCode = property(value, 'roleCode')
	return {
		id: requiredString(value, 'id'),
		clientId: requiredString(value, 'clientId'),
		name: requiredString(value, 'name'),
		created: requiredString(value, 'created'),
		lastUpdate: requiredString(value, 'lastUpdate'),
		projects: projects.map(readGrant),
		...(roleCode === undefined ? {} : { roleCode: asRoleCode(roleCode, 'the integration token') }),
	}
}

/**
 * The value served as a minted token's `token`. It is a LABEL, not a credential: no bearer check anywhere
 * accepts it, and it is derived from the record id so the state file never holds anything secret-shaped.
 */
const fakeIntegrationTokenValue = (tokenId: string): string => `not-a-real-zerops-${tokenId}`

class ZeropsEmulator {
	private constructor(
		private readonly options: ZeropsEmulatorOptions,
		private state: EmulatorSnapshot,
	) {}

	static async create(options: ZeropsEmulatorOptions): Promise<ZeropsEmulator> {
		if (options.token.trim() === '') {
			throw new Error('Zerops emulator token must not be empty')
		}
		if (options.activationDelayMs !== undefined && (!Number.isFinite(options.activationDelayMs) || options.activationDelayMs < 0)) {
			throw new Error('Zerops emulator activation delay must be a non-negative number')
		}
		return new ZeropsEmulator(options, await readSnapshot(options.stateFile))
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const path = url.pathname.replace(/^\/api\/rest\/public/, '')
		if (path === '/healthz' && request.method === 'GET') {
			return json({ ok: true })
		}
		if (request.headers.get('authorization') !== `Bearer ${this.options.token}`) {
			return error(401, 'UNAUTHORIZED', 'invalid bearer token')
		}
		if (path === '/__local/state' && request.method === 'GET') {
			return json(this.state)
		}
		if (path === '/__local/reset' && request.method === 'POST') {
			this.state = emptySnapshot()
			await this.persist()
			return json({ ok: true })
		}
		try {
			return await this.route(request, path, url)
		} catch (cause) {
			if (cause instanceof PlatformRefusal) {
				return error(cause.status, cause.code, cause.message)
			}
			const message = cause instanceof Error ? cause.message : 'invalid request'
			return error(400, 'BAD_REQUEST', message)
		}
	}

	private async route(request: Request, path: string, url: URL): Promise<Response> {
		const projectImport = path.match(/^\/client\/([^/]+)\/project\/import$/)
		if (projectImport !== null && request.method === 'POST') {
			const clientId = decodeURIComponent(projectImport[1] ?? '')
			const yaml = requiredString(await parseJsonBody(request), 'yaml')
			const document = parseImportDocument(yaml)
			if (document.project === undefined) {
				return error(400, 'PROJECT_REQUIRED', 'project import requires a project section')
			}
			const sameName = this.state.projects.filter((project) => project.clientId === clientId && project.name === document.project?.name)
			const project = sameName[0] ?? this.createProject(clientId, document)
			const services = this.importServices(project.id, document.services)
			await this.persist()
			return json(this.importResponse(project, services))
		}

		const serviceImport = path.match(/^\/project\/([^/]+)\/service-stack\/import$/)
		if (serviceImport !== null && request.method === 'POST') {
			const project = this.project(decodeURIComponent(serviceImport[1] ?? ''))
			if (project === undefined) {
				return error(404, 'PROJECT_NOT_FOUND', 'project not found')
			}
			const yaml = requiredString(await parseJsonBody(request), 'yaml')
			const document = parseImportDocument(yaml)
			const services = this.importServices(project.id, document.services)
			await this.persist()
			return json(this.importResponse(project, services))
		}

		const trigger = path.match(/^\/service-stack\/([^/]+)\/trigger-pipeline$/)
		if (trigger !== null && request.method === 'PUT') {
			const service = this.service(decodeURIComponent(trigger[1] ?? ''))
			if (service === undefined) {
				return serviceStackNotFound()
			}
			const triggerBody = await parseJsonBody(request)
			// A build source is a property of an app VERSION, never of the service, so every trigger must carry
			// one. The platform's refusal for an empty body reads "Service stack not found" — its wording, not a
			// guess — and nothing recorded its code, which is why the row asserts the status alone.
			if (stringProperty(triggerBody, 'buildFromGit') === undefined) {
				return serviceStackNotFound()
			}
			const activationDelayMs = this.options.activationDelayMs ?? 0
			const version: AppVersionRecord = {
				id: id('version', this.state.nextVersion++),
				serviceStackId: service.id,
				projectId: service.projectId,
				status: activationDelayMs === 0 ? 'ACTIVE' : 'BUILDING',
				sequence: this.state.appVersions.filter((item) => item.serviceStackId === service.id).length + 1,
				...(activationDelayMs === 0 ? {} : { activateAt: this.now() + activationDelayMs }),
			}
			this.state.appVersions.push(version)
			if (version.status === 'ACTIVE') {
				service.activeAppVersionId = version.id
			}
			// `stack.deploy` is the platform's own name for this one (docs/reference/zerops-platform.md).
			const started = this.createProcess('stack.deploy', { serviceStackId: service.id, appVersionId: version.id })
			await this.persist()
			return json({ process: this.processResponse(started) })
		}

		const processDetail = path.match(/^\/process\/([^/]+)$/)
		if (processDetail !== null && request.method === 'GET') {
			const found = this.process(decodeURIComponent(processDetail[1] ?? ''))
			if (found === undefined) {
				return error(404, 'PROCESS_NOT_FOUND', 'process not found')
			}
			// Render first, then spend the PENDING read: the first poll must SEE `PENDING`, or the wait never runs.
			const body = this.processResponse(found)
			if (found.pendingReads > 0) {
				found.pendingReads -= 1
				await this.persist()
			}
			return json(body)
		}

		const appVersion = path.match(/^\/app-version\/([^/]+)$/)
		if (appVersion !== null && request.method === 'GET') {
			await this.activateDueVersions()
			const version = this.version(decodeURIComponent(appVersion[1] ?? ''))
			// The platform answers 400 rather than 404 here; its CODE was never read off the wire, so the double
			// uses a deliberately synthetic SHOUTING_CASE one that could not be mistaken for the platform's.
			return version === undefined ? error(400, 'APP_VERSION_NOT_FOUND', 'app version not found') : json(version)
		}

		const cancel = path.match(/^\/app-version\/([^/]+)\/cancel-build$/)
		if (cancel !== null && request.method === 'PUT') {
			const version = this.version(decodeURIComponent(cancel[1] ?? ''))
			if (version === undefined) {
				return error(404, 'APP_VERSION_NOT_FOUND', 'app version not found')
			}
			version.status = 'CANCELLED'
			delete version.activateAt
			await this.persist()
			return json({})
		}

		const appVersions = path.match(/^\/service-stack\/([^/]+)\/app-version$/)
		if (appVersions !== null && request.method === 'GET') {
			await this.activateDueVersions()
			const serviceId = decodeURIComponent(appVersions[1] ?? '')
			if (this.service(serviceId) === undefined) {
				return error(404, 'SERVICE_NOT_FOUND', 'service not found')
			}
			const list = this.state.appVersions.filter((item) => item.serviceStackId === serviceId)
			return json({ list: this.page(list, url), totalCount: list.length })
		}

		// The precondition is real: the platform answers 400 `serviceStackIsNotHttp` until the service has
		// deployed an HTTP port, which is why an import alone can never establish a subdomain. An active
		// app version stands in for "has a deployed port" here. The double is idempotent where the platform
		// hands back a process that then fails; the client decides on the read-back either way. Note the
		// consequence for the process too: the one this returns always reaches FINISHED, where the
		// platform's FAILS on a service that already has a subdomain.
		const enableSubdomain = path.match(/^\/service-stack\/([^/]+)\/enable-subdomain-access$/)
		if (enableSubdomain !== null && request.method === 'PUT') {
			const found = this.service(decodeURIComponent(enableSubdomain[1] ?? ''))
			if (found === undefined) {
				return error(404, 'SERVICE_NOT_FOUND', 'service not found')
			}
			if (found.activeAppVersionId === undefined) {
				return error(400, 'serviceStackIsNotHttp', 'Service stack is not http or https')
			}
			found.subdomainAccess = true
			const started = this.createProcess('stack.enableSubdomainAccess', { serviceStackId: found.id })
			await this.persist()
			return json(this.processResponse(started))
		}

		const serviceByName = path.match(/^\/service-stack-by-name\/([^/]+)\/([^/]+)$/)
		if (serviceByName !== null && request.method === 'GET') {
			const projectId = decodeURIComponent(serviceByName[1] ?? '')
			const name = decodeURIComponent(serviceByName[2] ?? '')
			const service = this.state.services.find((item) => item.projectId === projectId && item.name === name)
			// The real platform answers a missing name with 400 `serviceStackNotFound`, not a 404.
			return service === undefined ? serviceStackNotFound() : json(this.serviceResponse(service))
		}

		// The whole service-stack family says "absent" as 400 `serviceStackNotFound` — id, name, and a service
		// deleted a moment ago alike (docs/reference/zerops-platform.md).
		const service = path.match(/^\/service-stack\/([^/]+)$/)
		if (service !== null && request.method === 'GET') {
			const found = this.service(decodeURIComponent(service[1] ?? ''))
			return found === undefined ? serviceStackNotFound() : json(this.serviceResponse(found))
		}

		// A delete answers a PENDING `stack.delete` process, not a 204, and the service is gone once it
		// finishes. Whether a read taken BETWEEN the two still answers 200 was never measured, so the record
		// goes at once and nothing here claims to know.
		if (service !== null && request.method === 'DELETE') {
			const found = this.service(decodeURIComponent(service[1] ?? ''))
			if (found === undefined) {
				return serviceStackNotFound()
			}
			this.state.services = this.state.services.filter((item) => item.id !== found.id)
			this.state.serviceEnv = this.state.serviceEnv.filter((item) => item.serviceStackId !== found.id)
			this.state.appVersions = this.state.appVersions.filter((item) => item.serviceStackId !== found.id)
			const removing = this.createProcess('stack.delete', { serviceStackId: found.id, projectId: found.projectId })
			await this.persist()
			return json(this.processResponse(removing))
		}

		const project = path.match(/^\/project\/([^/]+)$/)
		if (project !== null && request.method === 'GET') {
			const found = this.project(decodeURIComponent(project[1] ?? ''))
			return found === undefined ? error(404, 'PROJECT_NOT_FOUND', 'project not found') : json(found)
		}

		const listProjects = path.match(/^\/client\/([^/]+)\/project$/)
		if (listProjects !== null && request.method === 'GET') {
			const clientId = decodeURIComponent(listProjects[1] ?? '')
			const list = this.state.projects.filter((item) => item.clientId === clientId)
			return json({ list: this.page(list, url), totalCount: list.length })
		}

		// Mints a LABEL, not a credential — see `fakeIntegrationTokenValue`. The grants are recorded and
		// echoed back so a caller can check the scope it asked for, and nothing else happens: this double
		// enforces no scope, so the minted value opens exactly as much here as the configured bearer does.
		// Whether the platform rejects an unknown project, a repeated name, or client `NO_ACCESS` beside a
		// project grant is unverified against a real account, so none of it is refused here either.
		const integrationToken = path.match(/^\/client\/([^/]+)\/integration-token$/)
		if (integrationToken !== null && request.method === 'POST') {
			const body = await parseJsonBody(request)
			const grants = property(body, 'projects')
			if (!Array.isArray(grants)) {
				return error(400, 'invalidUserInput', 'projects is required')
			}
			const roleCode = property(body, 'roleCode')
			const timestamp = new Date(this.now()).toISOString()
			const record: IntegrationTokenRecord = {
				id: id('token', this.state.nextIntegrationToken++),
				clientId: decodeURIComponent(integrationToken[1] ?? ''),
				name: requiredString(body, 'name'),
				created: timestamp,
				lastUpdate: timestamp,
				projects: grants.map(readGrant),
				...(roleCode === undefined ? {} : { roleCode: asRoleCode(roleCode, 'the integration token request') }),
			}
			this.state.integrationTokens.push(record)
			await this.persist()
			return json({
				id: record.id,
				name: record.name,
				created: record.created,
				lastUpdate: record.lastUpdate,
				projects: record.projects,
				token: fakeIntegrationTokenValue(record.id),
				...(record.roleCode === undefined ? {} : { roleCode: record.roleCode }),
			}, 201)
		}

		const projectsByName = path.match(/^\/client\/([^/]+)\/projects-by-name\/([^/]+)$/)
		if (projectsByName !== null && request.method === 'GET') {
			const clientId = decodeURIComponent(projectsByName[1] ?? '')
			const name = decodeURIComponent(projectsByName[2] ?? '')
			return json({ projects: this.state.projects.filter((item) => item.clientId === clientId && item.name === name) })
		}

		const projectServices = path.match(/^\/project\/([^/]+)\/service-stack$/)
		if (projectServices !== null && request.method === 'GET') {
			const projectId = decodeURIComponent(projectServices[1] ?? '')
			if (this.project(projectId) === undefined) {
				return error(404, 'PROJECT_NOT_FOUND', 'project not found')
			}
			const list = this.state.services.filter((item) => item.projectId === projectId).map((item) => this.serviceResponse(item))
			return json({ list: this.page(list, url), totalCount: list.length })
		}

		// The real platform answers 400 `serviceStackNotFound` here on EVERY service, deployed or not — and on
		// an id that never existed — so a client that lists before writing must fail against the double too
		// (docs/reference/zerops-platform.md).
		if (/^\/service-stack\/[^/]+\/user-data$/.test(path) && request.method === 'GET') {
			return serviceStackNotFound()
		}

		const serviceEnvList = path.match(/^\/service-stack\/([^/]+)\/env$/)
		if (serviceEnvList !== null && request.method === 'GET') {
			const serviceId = decodeURIComponent(serviceEnvList[1] ?? '')
			if (this.service(serviceId) === undefined) {
				return error(404, 'SERVICE_NOT_FOUND', 'service not found')
			}
			return json({ items: this.state.serviceEnv.filter((item) => item.serviceStackId === serviceId) })
		}

		const serviceEnv = path.match(/^\/service-stack\/([^/]+)\/user-data$/)
		if (serviceEnv !== null && request.method === 'POST') {
			const serviceId = decodeURIComponent(serviceEnv[1] ?? '')
			if (this.service(serviceId) === undefined) {
				return serviceStackNotFound()
			}
			const body = await parseJsonBody(request)
			const key = requiredString(body, 'key')
			// `sensitive` is required on every write, create and update alike — omitting it is `invalidUserInput`
			// with `{"sensitive":["field is required"]}`, which is what stopped a namespace provision dead.
			if (booleanProperty(body, 'sensitive') === undefined) {
				return sensitiveIsRequired()
			}
			if (key.startsWith(RESERVED_KEY_PREFIX)) {
				return error(400, 'userDataZeropsPrefixForbidden', `UserData key '${key}' uses a reserved prefix.`)
			}
			if (this.state.serviceEnv.some((item) => item.serviceStackId === serviceId && item.key === key)) {
				return error(400, 'userDataDuplicateKey', `UserData key '${key}' is not unique in service stack frame of reference.`)
			}
			const record: ServiceEnvRecord = {
				id: id('env', this.state.nextEnv++),
				serviceStackId: serviceId,
				key,
				content: requiredString(body, 'content'),
				type: 'SECRET',
			}
			this.state.serviceEnv.push(record)
			const created = this.createProcess('stack.updateUserData', { serviceStackId: serviceId })
			await this.persist()
			// Live answers the PROCESS, not the record, with a 200 rather than a 201 — and refuses the next
			// operation on the service until it finishes (`400 userDataSyncRunning`).
			return json(this.processResponse(created))
		}

		const env = path.match(/^\/user-data\/([^/]+)$/)
		if (env !== null) {
			const envId = decodeURIComponent(env[1] ?? '')
			const index = this.state.serviceEnv.findIndex((item) => item.id === envId)
			if (index < 0) {
				return error(404, 'USER_DATA_NOT_FOUND', 'user data not found')
			}
			if (request.method === 'PUT') {
				const body = await parseJsonBody(request)
				const current = this.state.serviceEnv[index]
				if (current === undefined) {
					return error(404, 'USER_DATA_NOT_FOUND', 'user data not found')
				}
				// Both fields are required even when the key is unchanged, and so is `sensitive`.
				const key = stringProperty(body, 'key')
				const content = stringProperty(body, 'content')
				if (key === undefined || content === undefined) {
					return error(400, 'invalidUserInput', 'key and content are both required')
				}
				if (booleanProperty(body, 'sensitive') === undefined) {
					return sensitiveIsRequired()
				}
				current.key = key
				current.content = content
				const replaced = this.createProcess('stack.updateUserData', { serviceStackId: current.serviceStackId })
				await this.persist()
				return json(this.processResponse(replaced))
			}
			if (request.method === 'DELETE') {
				const removed = this.state.serviceEnv.splice(index, 1)[0]
				const dropped = this.createProcess('stack.updateUserData', {
					...(removed === undefined ? {} : { serviceStackId: removed.serviceStackId }),
				})
				await this.persist()
				return json(this.processResponse(dropped))
			}
		}

		const projectLog = path.match(/^\/project\/([^/]+)\/log$/)
		if (projectLog !== null && request.method === 'GET') {
			if (this.project(decodeURIComponent(projectLog[1] ?? '')) === undefined) {
				return error(404, 'PROJECT_NOT_FOUND', 'project not found')
			}
			return json({
				url: '',
				urlPlain: '',
				urlInfo: '',
				urlUi: '',
				accessToken: '',
				expiration: new Date(Date.now() + 60_000).toISOString(),
			})
		}

		return error(404, 'NOT_FOUND', 'endpoint is outside the local Zerops contract')
	}

	private createProject(clientId: string, document: ImportDocument): ProjectRecord {
		const spec = document.project
		if (spec === undefined) {
			throw new Error('project spec is required')
		}
		const project: ProjectRecord = {
			id: id('project', this.state.nextProject++),
			clientId,
			name: spec.name,
			status: 'ACTIVE',
			mode: spec.corePackage === 'SERIOUS' ? 'SERIOUS' : 'LIGHT',
			...(spec.description === undefined ? {} : { description: spec.description }),
			...(spec.tags === undefined ? {} : { tagList: spec.tags }),
		}
		this.state.projects.push(project)
		return project
	}

	private importServices(projectId: string, specs: ImportService[]): ImportOutcome[] {
		// Without `override` a name that already exists fails the ENTIRE import, managed services included —
		// so the refusal is decided before a single service is created.
		const collision = specs.find((spec) =>
			spec.override !== true && this.state.services.some((service) => service.projectId === projectId && service.name === spec.hostname)
		)
		if (collision !== undefined) {
			throw new PlatformRefusal(400, 'serviceStackNameUnavailable', 'Project has already serviceStack with the same name')
		}
		return specs.map((spec) => {
			const existing = this.state.services.find((service) => service.projectId === projectId && service.name === spec.hostname)
			if (existing !== undefined) {
				// An `override` re-apply reconciles NOTHING live: a changed `type`, `profile`, `maxContainers` or
				// `objectStorageSize` is silently ignored and the service is left exactly as it is.
				return { service: existing }
			}
			// `subdomainAccess` starts false and no import ever moves it — see `ImportService`.
			const service: ServiceRecord = {
				id: id('service', this.state.nextService++),
				projectId,
				name: spec.hostname,
				status: 'ACTIVE',
				subdomainAccess: false,
				...(spec.type === undefined ? {} : { base: spec.type }),
				...(spec.profile === undefined ? {} : { autoscalingProfileId: spec.profile }),
			}
			this.state.services.push(service)
			// UNVERIFIED NAME: nothing records what the platform calls an import's own processes. The
			// existence of one per created service is the verified half.
			return { service, process: this.createProcess('stack.create', { serviceStackId: service.id }) }
		})
	}

	private importResponse(project: ProjectRecord, imported: ImportOutcome[]): unknown {
		return {
			projectId: project.id,
			projectName: project.name,
			serviceStacks: imported.map((entry) => ({
				id: entry.service.id,
				name: entry.service.name,
				// Only a service this import CREATED gets a process: re-applying an unchanged document is a
				// complete no-op live — same ids, no processes (docs/reference/zerops-platform.md).
				processes: entry.process === undefined ? [] : [this.processResponse(entry.process)],
			})),
		}
	}

	private createProcess(actionName: string, fields: { serviceStackId?: string; projectId?: string; appVersionId?: string }): ProcessRecord {
		const record: ProcessRecord = {
			id: id('process', this.state.nextProcess++),
			actionName,
			pendingReads: 1,
			...(fields.serviceStackId === undefined ? {} : { serviceStackId: fields.serviceStackId }),
			...(fields.projectId === undefined ? {} : { projectId: fields.projectId }),
			...(fields.appVersionId === undefined ? {} : { appVersionId: fields.appVersionId }),
		}
		this.state.processes.push(record)
		return record
	}

	private processResponse(record: ProcessRecord): unknown {
		return {
			id: record.id,
			status: record.pendingReads > 0 ? 'PENDING' : 'FINISHED',
			actionName: record.actionName,
			...(record.serviceStackId === undefined ? {} : { serviceStackId: record.serviceStackId }),
			...(record.projectId === undefined ? {} : { projectId: record.projectId }),
			...(record.appVersionId === undefined ? {} : { appVersion: { id: record.appVersionId } }),
		}
	}

	private serviceResponse(service: ServiceRecord): unknown {
		return {
			...service,
			...(service.activeAppVersionId === undefined ? {} : { activeAppVersion: { id: service.activeAppVersionId } }),
		}
	}

	private project(projectId: string): ProjectRecord | undefined {
		return this.state.projects.find((project) => project.id === projectId)
	}

	private service(serviceId: string): ServiceRecord | undefined {
		return this.state.services.find((service) => service.id === serviceId)
	}

	private version(appVersionId: string): AppVersionRecord | undefined {
		return this.state.appVersions.find((version) => version.id === appVersionId)
	}

	private process(processId: string): ProcessRecord | undefined {
		return this.state.processes.find((record) => record.id === processId)
	}

	private now(): number {
		return this.options.now?.() ?? Date.now()
	}

	private async activateDueVersions(): Promise<void> {
		let changed = false
		for (const version of this.state.appVersions) {
			if (version.status !== 'BUILDING' || version.activateAt === undefined || version.activateAt > this.now()) {
				continue
			}
			version.status = 'ACTIVE'
			delete version.activateAt
			const service = this.service(version.serviceStackId)
			if (service !== undefined) {
				service.activeAppVersionId = version.id
			}
			changed = true
		}
		if (changed) {
			await this.persist()
		}
	}

	private page<Item>(items: Item[], url: URL): Item[] {
		const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
		const limit = Number.parseInt(url.searchParams.get('limit') ?? String(items.length), 10)
		return items.slice(offset, offset + limit)
	}

	private async persist(): Promise<void> {
		if (this.options.stateFile !== undefined) {
			await Bun.write(this.options.stateFile, `${JSON.stringify(this.state, null, 2)}\n`)
		}
	}
}

export const createZeropsEmulator = async (options: ZeropsEmulatorOptions): Promise<(request: Request) => Promise<Response>> => {
	const emulator = await ZeropsEmulator.create(options)
	return (request) => emulator.fetch(request)
}
