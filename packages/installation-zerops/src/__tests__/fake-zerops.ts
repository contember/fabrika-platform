// A Zerops account, in memory — enough of one to drive the whole deploy sequence AND the from-scratch
// bring-up, and to read back the ORDER either happened in.
//
// Every method of `ZeropsApi` is present. The BOOTSTRAP surface — `importServices`, `getProcess` and
// `createIntegrationToken` — throws unless the fixture opts into it, so a `platform deploy` that ever
// reaches for one fails the suite instead of quietly working; `importProject` has its own opt-in, so a
// run given a project id that creates one anyway fails too; and a project-level write has no opt-in at
// all, because nothing may ever make one (ADR-0004).

import {
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsProjectMode,
	type ZeropsProjectStatus,
	type ZeropsService,
	type ZeropsServiceEnv,
	type ZeropsServiceStatus,
} from '@fabrika/provider-zerops'

export interface FakeServiceSpec {
	readonly name: string
	readonly id: string
	readonly subdomainAccess?: boolean
	readonly env?: Readonly<Record<string, string>>
	readonly sequence?: number
	/** What `listProjectServices` reports. `NEW` is a service the platform has not finished creating. */
	readonly status?: ZeropsServiceStatus
	/** How many processes an import of this service hands back. Live: 1 for managed, 2 for a runtime. */
	readonly importProcesses?: number
}

/** What an `importServices` call is allowed to create, and which client a token may be minted on. */
export interface FakeBootstrap {
	readonly clientId: string
	/** The services the imported document creates, in the order the platform reports them. */
	readonly imported: readonly FakeServiceSpec[]
}

/**
 * A project this account does NOT have yet: `importProject` creates it, and only then can it be read.
 *
 * Present only in the `--create-project` fixtures. Without it `importProject` still throws, so a run that
 * was given a project id and creates one anyway fails the suite.
 */
export interface FakeProjectCreation {
	readonly clientId: string
	/**
	 * What `getProject` answers, one status per read, the last one repeating.
	 * Live (2026-08-21): `NEW` at t+1 s → `CREATING` → `ACTIVE` at about t+20 s.
	 */
	readonly statuses?: readonly ZeropsProjectStatus[]
}

export interface FakeZerops {
	readonly api: ZeropsApi
	/** Every effect, in the order it happened: `env:<service>:<KEY>`, `deploy:<service>`, … */
	readonly calls: string[]
	/**
	 * Every API call including the READS, in order — `readenv:<service>`, `services:`, `process:<id>`.
	 * Separate from `calls` because a read is not an effect, and several suites assert that a run made no
	 * effect at all while reading plenty.
	 */
	readonly timeline: string[]
	/** Every process id an import handed back, so a test can prove each one was waited on. */
	readonly importedProcesses: string[]
	/** Every import document applied, as the YAML text that was sent. */
	readonly imports: string[]
	/** Every PROJECT import document applied — kept apart, because it is a different endpoint. */
	readonly projectImports: string[]
	/** The plaintext of every integration token this fake minted, so a test can hunt for it in a log. */
	readonly mintedTokens: string[]
	env(service: string): Map<string, string>
	subdomainAccess(service: string): boolean
	/** Make one write fail, so the fail-closed path can be exercised. */
	failWrite(service: string, key: string): void
	/** Make one service's deploy end in a terminal non-ACTIVE status. */
	failDeploy(service: string): void
	/** Make the next N triggers of one service answer `userDataSyncRunning`, as a live one can. */
	blockTrigger(service: string, times: number): void
}

const NEVER = (name: string) => (): never => {
	throw new Error(`platform deploy must not call ${name}`)
}

export const fakeZerops = (options: {
	readonly projectId: string
	readonly projectName: string
	readonly projectMode?: ZeropsProjectMode
	readonly services: readonly FakeServiceSpec[]
	readonly bootstrap?: FakeBootstrap
	/** When set, the project does not exist until `importProject` creates it. */
	readonly creates?: FakeProjectCreation
}): FakeZerops => {
	const calls: string[] = []
	const timeline: string[] = []
	const importedProcesses: string[] = []
	const imports: string[] = []
	const projectImports: string[] = []
	const mintedTokens: string[] = []
	const live: FakeServiceSpec[] = [...options.services]
	const byName = new Map(live.map((service) => [service.name, service]))
	const idToName = new Map(live.map((service) => [service.id, service.name]))
	const env = new Map(live.map((service) => [service.name, new Map(Object.entries(service.env ?? {}))]))
	const published = new Map(live.map((service) => [service.name, service.subdomainAccess === true]))
	const sequence = new Map(live.map((service) => [service.name, service.sequence ?? 0]))
	const failedWrites = new Set<string>()
	const failedDeploys = new Set<string>()
	const blockedTriggers = new Map<string, number>()
	const processes = new Map<string, string>()

	const nameOf = (serviceId: string): string => {
		const name = idToName.get(serviceId)
		if (name === undefined) {
			throw new Error(`unknown service id ${serviceId}`)
		}
		return name
	}
	const envOf = (name: string): Map<string, string> => {
		const values = env.get(name)
		if (values === undefined) {
			throw new Error(`unknown service ${name}`)
		}
		return values
	}

	/** An EFFECT: recorded in both, because `calls` is what a test asserting "nothing happened" reads. */
	const effect = (entry: string): void => {
		calls.push(entry)
		timeline.push(entry)
	}
	/** A READ: the timeline only. */
	const observe = (entry: string): void => void timeline.push(entry)

	const bootstrap = options.bootstrap
	/** Which service each in-flight import process belongs to, so the last one can settle it. */
	const settles = new Map<string, FakeServiceSpec>()

	const creates = options.creates
	const projectStatuses: readonly ZeropsProjectStatus[] = creates?.statuses ?? ['ACTIVE']
	let projectExists = creates === undefined
	let projectReads = 0

	const admit = (service: FakeServiceSpec): void => {
		live.push(service)
		byName.set(service.name, service)
		idToName.set(service.id, service.name)
		env.set(service.name, new Map(Object.entries(service.env ?? {})))
		published.set(service.name, service.subdomainAccess === true)
		sequence.set(service.name, service.sequence ?? 0)
	}
	/** A service leaving `NEW`: the status moves and the platform's generated keys appear with it. */
	const replace = (service: FakeServiceSpec): void => {
		const at = live.findIndex((existing) => existing.name === service.name)
		if (at >= 0) {
			live[at] = service
		}
		byName.set(service.name, service)
		env.set(service.name, new Map(Object.entries(service.env ?? {})))
	}

	const api: ZeropsApi = {
		createAppVersion: NEVER('createAppVersion'),
		buildAndDeployAppVersion: NEVER('buildAndDeployAppVersion'),
		deleteAppVersion: NEVER('deleteAppVersion'),
		cancelBuild: NEVER('cancelBuild'),
		deleteServiceEnv: NEVER('deleteServiceEnv'),
		getProjectEnv: NEVER('getProjectEnv'),
		getLogAccess: NEVER('getLogAccess'),
		readBuildLog: NEVER('readBuildLog'),
		listProjects: NEVER('listProjects'),
		findService: NEVER('findService'),

		/** `POST /client/{id}/project/import`. The project exists only after this, and only once. */
		importProject: async ({ clientId, yaml }) => {
			if (creates === undefined) {
				return NEVER('importProject')()
			}
			if (clientId !== creates.clientId) {
				throw new Error(`zerops: project import failed (404)`)
			}
			if (projectExists) {
				throw new Error('zerops: a second project was imported for one installation')
			}
			effect(`project-import:${clientId}`)
			projectImports.push(yaml)
			projectExists = true
			return { projectId: options.projectId, projectName: options.projectName, services: [] }
		},

		importServices: async ({ projectId, yaml }) => {
			if (bootstrap === undefined) {
				return NEVER('importServices')()
			}
			if (projectId !== options.projectId) {
				throw new Error(`zerops: service-stack import failed (404)`)
			}
			effect(`import:${projectId}`)
			imports.push(yaml)
			// Live: the call returns at once and the services are `NEW` with ZERO environment keys, gaining
			// them one service at a time as the platform works down `priority`. Modelled by admitting each
			// service as NEW and flipping it once its LAST process reports FINISHED.
			return {
				projectId,
				services: bootstrap.imported.map((service) => {
					if (!byName.has(service.name)) {
						admit({ ...service, status: 'NEW', env: {} })
					}
					const ids = Array.from({ length: service.importProcesses ?? 1 }, (_, index) => `process-import-${service.name}-${index}`)
					for (const id of ids) {
						processes.set(id, 'PENDING')
						importedProcesses.push(id)
						settles.set(id, service)
					}
					return { id: service.id, name: service.name, processes: ids.map((id) => ({ id, status: 'PENDING' })) }
				}),
			}
		},

		/** One poll answers `PENDING`, the next `FINISHED` — so a caller that never waits is visible. */
		getProcess: async ({ processId }) => {
			if (bootstrap === undefined) {
				return NEVER('getProcess')()
			}
			observe(`process:${processId}`)
			const seen = processes.get(processId)
			processes.set(processId, 'FINISHED')
			if (seen !== 'PENDING') {
				// The service leaves `NEW` and gains its generated keys only now, which is the ordering the
				// install must respect: nothing may read or write it before this.
				const settled = settles.get(processId)
				if (settled !== undefined && [...processes].every(([id, status]) => settles.get(id) !== settled || status === 'FINISHED')) {
					replace({ ...settled, status: 'ACTIVE' })
				}
			}
			return { id: processId, status: seen === 'PENDING' ? 'PENDING' : 'FINISHED' }
		},

		createIntegrationToken: async ({ clientId, name, projects, roleCode }) => {
			if (bootstrap === undefined) {
				return NEVER('createIntegrationToken')()
			}
			if (clientId !== bootstrap.clientId) {
				throw new Error(`zerops: create integration token failed (404)`)
			}
			effect(`token:${clientId}`)
			const token = `zerops-integration-token-${mintedTokens.length}-must-never-be-printed`
			mintedTokens.push(token)
			return {
				id: `token-${mintedTokens.length}`,
				name,
				token,
				projects: projects.map((grant) => ({ projectId: grant.projectId, roleCode: grant.roleCode })),
				...(roleCode === undefined ? {} : { roleCode }),
			}
		},

		getProject: async ({ projectId }) => {
			if (projectId !== options.projectId || !projectExists) {
				throw new Error(`zerops: get project failed (404)`)
			}
			const status = projectStatuses[Math.min(projectReads, projectStatuses.length - 1)] ?? 'ACTIVE'
			projectReads += 1
			observe(`project:${projectId}:${status}`)
			return {
				id: options.projectId,
				name: options.projectName,
				status,
				...(options.projectMode === undefined ? {} : { mode: options.projectMode }),
			}
		},

		findProjects: async ({ name }) => (name === options.projectName ? [{ id: options.projectId, name }] : []),

		listProjectServices: async () => {
			observe('services:')
			return live.map((service): ZeropsService => ({
				id: service.id,
				name: service.name,
				projectId: options.projectId,
				status: service.status ?? 'ACTIVE',
				subdomainAccess: published.get(service.name) === true,
			}))
		},

		getService: async ({ serviceId }) => {
			const name = nameOf(serviceId)
			observe(`service:${name}`)
			return { id: serviceId, name, projectId: options.projectId, subdomainAccess: published.get(name) === true }
		},

		listServiceEnv: async ({ serviceId }) => {
			const name = nameOf(serviceId)
			observe(`readenv:${name}`)
			return [...envOf(name)].map(([key, content]): ZeropsServiceEnv => ({ id: `${name}:${key}`, key, content, serviceStackId: serviceId }))
		},

		createServiceEnv: async ({ serviceId, key, value }) => {
			const name = nameOf(serviceId)
			if (failedWrites.delete(`${name}:${key}`)) throw new Error('zerops: create-only service env failed')
			if (envOf(name).has(key)) throw new Error('zerops: create-only service env failed')
			effect(`env:${name}:${key}`)
			envOf(name).set(key, value)
		},

		putServiceEnv: async ({ serviceId, key, value }) => {
			const name = nameOf(serviceId)
			if (failedWrites.delete(`${name}:${key}`)) {
				throw new Error(`zerops: create service env failed (400)`)
			}
			effect(`env:${name}:${key}`)
			envOf(name).set(key, value)
		},

		triggerPipeline: async ({ serviceId, zeropsSetup }) => {
			const name = nameOf(serviceId)
			const blocked = blockedTriggers.get(name) ?? 0
			if (blocked > 0) {
				blockedTriggers.set(name, blocked - 1)
				effect(`blocked:${name}`)
				throw new ZeropsApiError('zerops: trigger-pipeline failed (400)', 400, 'userDataSyncRunning')
			}
			if (zeropsSetup !== name) {
				throw new Error(`zerops: setup ${zeropsSetup ?? '(none)'} does not match service ${name}`)
			}
			effect(`deploy:${name}`)
			const next = (sequence.get(name) ?? 0) + 1
			sequence.set(name, next)
			// Live-observed (WU1): the six per-port lines appear with the version that publishes the ports,
			// in the same poll that first reads ACTIVE. Before that the variable names one host with no port
			// segment, which `derivePlatformHosts` correctly refuses.
			if (name === 'proxy') {
				envOf(name).set('zeropsSubdomain', SUBDOMAINS)
			}
			return { id: `process-${name}-${next}`, appVersionId: `${name}-v${next}` }
		},

		latestAppVersion: async ({ serviceId }): Promise<ZeropsAppVersion | null> => {
			const name = nameOf(serviceId)
			const seq = sequence.get(name) ?? 0
			return seq === 0 ? null : { id: `${name}-v${seq}`, sequence: seq }
		},

		getAppVersion: async ({ appVersionId }) => {
			const name = appVersionId.slice(0, appVersionId.lastIndexOf('-v'))
			return { id: appVersionId, status: failedDeploys.has(name) ? 'DEPLOY_FAILED' : 'ACTIVE' }
		},

		enableSubdomainAccess: async ({ serviceId }) => {
			const name = nameOf(serviceId)
			effect(`subdomain:${name}`)
			published.set(name, true)
		},
	}

	return {
		api,
		calls,
		timeline,
		importedProcesses,
		imports,
		projectImports,
		mintedTokens,
		env: (service) => envOf(service),
		subdomainAccess: (service) => published.get(service) === true,
		failWrite: (service, key) => void failedWrites.add(`${service}:${key}`),
		failDeploy: (service) => void failedDeploys.add(service),
		blockTrigger: (service, times) => void blockedTriggers.set(service, times),
	}
}

/**
 * The six services the light services-only provisioning document creates, as a settled but
 * never-deployed project has them.
 *
 * The process COUNTS are the ones a live import returned (2026-08-10): one per managed service, two per
 * runtime service. `zeropsSubdomain` naming ONE host with no port segment is what WU1 read off a real
 * proxy before its first deploy — and, per the same measurement, it appears only once the service has
 * left `NEW`, which is what the fake's process bookkeeping models.
 */
export const importedLightServices = (): FakeServiceSpec[] => [
	{ name: 'db', id: 'svc-db', importProcesses: 1 },
	{ name: 'storage', id: 'svc-storage', importProcesses: 1 },
	{ name: 'iam', id: 'svc-iam', importProcesses: 2 },
	{ name: 'operations', id: 'svc-operations', importProcesses: 2 },
	{ name: 'source', id: 'svc-source', importProcesses: 2 },
	{ name: 'control', id: 'svc-control', importProcesses: 2 },
	{ name: 'proxy', id: 'svc-proxy', importProcesses: 2, env: { zeropsSubdomain: 'https://proxy-292c.prg1.zerops.app' } },
]

/** The four platform services, shaped like the live `fabrika-test` installation. */
export const platformServices = (env: Readonly<Record<string, Readonly<Record<string, string>>>> = {}): FakeServiceSpec[] => [
	{ name: 'db', id: 'svc-db' },
	{ name: 'iam', id: 'svc-iam', sequence: 4, ...(env['iam'] === undefined ? {} : { env: env['iam'] }) },
	{ name: 'operations', id: 'svc-operations', sequence: 4, ...(env['operations'] === undefined ? {} : { env: env['operations'] }) },
	{ name: 'source', id: 'svc-source', sequence: 4, ...(env['source'] === undefined ? {} : { env: env['source'] }) },
	{ name: 'control', id: 'svc-control', sequence: 4, ...(env['control'] === undefined ? {} : { env: env['control'] }) },
	{ name: 'proxy', id: 'svc-proxy', sequence: 4, subdomainAccess: true, ...(env['proxy'] === undefined ? {} : { env: env['proxy'] }) },
	// A stopped build runtime shares the project and must never be mistaken for a platform service.
	{ name: 'buildiamv1785763377', id: 'svc-build-iam' },
]

/** What the proxy's READ_ONLY `zeropsSubdomain` looks like: one URL per published HTTP port. */
export const SUBDOMAINS = [
	'https://proxy-292c-8080.prg1.zerops.app',
	'https://proxy-292c-8082.prg1.zerops.app',
	'https://proxy-292c-8083.prg1.zerops.app',
	'https://proxy-292c-8084.prg1.zerops.app',
	'https://proxy-292c-8085.prg1.zerops.app',
	'https://proxy-292c-8086.prg1.zerops.app',
].join('\n')
