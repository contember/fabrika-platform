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

interface EmulatorSnapshot {
	nextProject: number
	nextService: number
	nextEnv: number
	nextVersion: number
	nextProcess: number
	projects: ProjectRecord[]
	services: ServiceRecord[]
	serviceEnv: ServiceEnvRecord[]
	appVersions: AppVersionRecord[]
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
	projects: [],
	services: [],
	serviceEnv: [],
	appVersions: [],
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
		return {
			hostname,
			...(stringProperty(entry, 'type') === undefined ? {} : { type: stringProperty(entry, 'type') }),
			...(stringProperty(entry, 'profile') === undefined ? {} : { profile: stringProperty(entry, 'profile') }),
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

const parseJsonBody = async (request: Request): Promise<unknown> => {
	try {
		return await request.json()
	} catch {
		throw new Error('request body must be JSON')
	}
}

const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

const error = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status)

const id = (prefix: string, sequence: number): string => `${prefix}-${sequence.toString().padStart(6, '0')}`

const readSnapshot = async (path: string | undefined): Promise<EmulatorSnapshot> => {
	if (path === undefined || !(await Bun.file(path).exists())) {
		return emptySnapshot()
	}
	const value: unknown = await Bun.file(path).json()
	const counters = ['nextProject', 'nextService', 'nextEnv', 'nextVersion', 'nextProcess']
	const arrays = ['projects', 'services', 'serviceEnv', 'appVersions']
	if (
		typeof value !== 'object'
		|| value === null
		|| counters.some((key) => typeof property(value, key) !== 'number')
		|| arrays.some((key) => !Array.isArray(property(value, key)))
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
		projects: projects.map(readProjectRecord),
		services: services.map(readServiceRecord),
		serviceEnv: serviceEnv.map(readServiceEnvRecord),
		appVersions: appVersions.map(readAppVersionRecord),
	}
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
				return error(404, 'SERVICE_NOT_FOUND', 'service not found')
			}
			await parseJsonBody(request)
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
			const processId = id('process', this.state.nextProcess++)
			await this.persist()
			return json({
				process: {
					id: processId,
					status: 'FINISHED',
					actionName: 'triggerPipeline',
					serviceStackId: service.id,
					appVersion: { id: version.id },
				},
			})
		}

		const appVersion = path.match(/^\/app-version\/([^/]+)$/)
		if (appVersion !== null && request.method === 'GET') {
			await this.activateDueVersions()
			const version = this.version(decodeURIComponent(appVersion[1] ?? ''))
			return version === undefined ? error(404, 'APP_VERSION_NOT_FOUND', 'app version not found') : json(version)
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
		// hands back a process that then fails; the client decides on the read-back either way.
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
			const processId = id('process', this.state.nextProcess++)
			await this.persist()
			return json({ id: processId, status: 'FINISHED', actionName: 'stack.enableSubdomainAccess', serviceStackId: found.id })
		}

		const serviceByName = path.match(/^\/service-stack-by-name\/([^/]+)\/([^/]+)$/)
		if (serviceByName !== null && request.method === 'GET') {
			const projectId = decodeURIComponent(serviceByName[1] ?? '')
			const name = decodeURIComponent(serviceByName[2] ?? '')
			const service = this.state.services.find((item) => item.projectId === projectId && item.name === name)
			return service === undefined ? error(404, 'SERVICE_NOT_FOUND', 'service not found') : json(this.serviceResponse(service))
		}

		const service = path.match(/^\/service-stack\/([^/]+)$/)
		if (service !== null && request.method === 'GET') {
			const found = this.service(decodeURIComponent(service[1] ?? ''))
			return found === undefined ? error(404, 'SERVICE_NOT_FOUND', 'service not found') : json(this.serviceResponse(found))
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

		// The real platform answers 400 `serviceStackNotFound` here on EVERY service, deployed or not, so a
		// client that lists before writing must fail against the double too (docs/reference/zerops-platform.md).
		if (/^\/service-stack\/[^/]+\/user-data$/.test(path) && request.method === 'GET') {
			return error(400, 'serviceStackNotFound', 'Service stack not found.')
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
				return error(404, 'SERVICE_NOT_FOUND', 'service not found')
			}
			const body = await parseJsonBody(request)
			const key = requiredString(body, 'key')
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
			await this.persist()
			return json(record, 201)
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
				current.key = requiredString(body, 'key')
				current.content = requiredString(body, 'content')
				await this.persist()
				return json(current)
			}
			if (request.method === 'DELETE') {
				this.state.serviceEnv.splice(index, 1)
				await this.persist()
				return new Response(null, { status: 204 })
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

	private importServices(projectId: string, specs: ImportService[]): ServiceRecord[] {
		return specs.map((spec) => {
			const existing = this.state.services.find((service) => service.projectId === projectId && service.name === spec.hostname)
			if (existing !== undefined) {
				existing.base = spec.type
				existing.autoscalingProfileId = spec.profile
				return existing
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
			return service
		})
	}

	private importResponse(project: ProjectRecord, services: ServiceRecord[]): unknown {
		return {
			projectId: project.id,
			projectName: project.name,
			serviceStacks: services.map((service) => ({ id: service.id, name: service.name, processes: [] })),
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
