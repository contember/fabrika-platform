// A Zerops account, in memory — enough of one to drive the whole deploy sequence and read back the
// ORDER it happened in. Every method of `ZeropsApi` is present; the ones this command must never call
// throw, so a future step that reaches for `importServices` or a project-level write fails the suite
// instead of quietly working.

import { type ZeropsApi, ZeropsApiError, type ZeropsAppVersion, type ZeropsService, type ZeropsServiceEnv } from '@fabrika/provider-zerops'

export interface FakeServiceSpec {
	readonly name: string
	readonly id: string
	readonly subdomainAccess?: boolean
	readonly env?: Readonly<Record<string, string>>
	readonly sequence?: number
}

export interface FakeZerops {
	readonly api: ZeropsApi
	/** Every effect, in the order it happened: `env:<service>:<KEY>`, `deploy:<service>`, … */
	readonly calls: string[]
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
	readonly services: readonly FakeServiceSpec[]
}): FakeZerops => {
	const calls: string[] = []
	const byName = new Map(options.services.map((service) => [service.name, service]))
	const idToName = new Map(options.services.map((service) => [service.id, service.name]))
	const env = new Map(options.services.map((service) => [service.name, new Map(Object.entries(service.env ?? {}))]))
	const published = new Map(options.services.map((service) => [service.name, service.subdomainAccess === true]))
	const sequence = new Map(options.services.map((service) => [service.name, service.sequence ?? 0]))
	const failedWrites = new Set<string>()
	const failedDeploys = new Set<string>()
	const blockedTriggers = new Map<string, number>()

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

	const api: ZeropsApi = {
		importServices: NEVER('importServices'),
		importProject: NEVER('importProject'),
		cancelBuild: NEVER('cancelBuild'),
		getProcess: NEVER('getProcess'),
		createIntegrationToken: NEVER('createIntegrationToken'),
		deleteServiceEnv: NEVER('deleteServiceEnv'),
		getProjectEnv: NEVER('getProjectEnv'),
		getLogAccess: NEVER('getLogAccess'),
		readBuildLog: NEVER('readBuildLog'),
		listProjects: NEVER('listProjects'),
		findService: NEVER('findService'),

		getProject: async ({ projectId }) => {
			if (projectId !== options.projectId) {
				throw new Error(`zerops: get project failed (404)`)
			}
			return { id: options.projectId, name: options.projectName, status: 'ACTIVE' }
		},

		findProjects: async ({ name }) => (name === options.projectName ? [{ id: options.projectId, name }] : []),

		listProjectServices: async () =>
			options.services.map((service): ZeropsService => ({
				id: service.id,
				name: service.name,
				projectId: options.projectId,
				status: 'ACTIVE',
				subdomainAccess: published.get(service.name) === true,
			})),

		getService: async ({ serviceId }) => {
			const name = nameOf(serviceId)
			return { id: serviceId, name, projectId: options.projectId, subdomainAccess: published.get(name) === true }
		},

		listServiceEnv: async ({ serviceId }) => {
			const name = nameOf(serviceId)
			return [...envOf(name)].map(([key, content]): ZeropsServiceEnv => ({ id: `${name}:${key}`, key, content, serviceStackId: serviceId }))
		},

		putServiceEnv: async ({ serviceId, key, value }) => {
			const name = nameOf(serviceId)
			if (failedWrites.has(`${name}:${key}`)) {
				throw new Error(`zerops: create service env failed (400)`)
			}
			calls.push(`env:${name}:${key}`)
			envOf(name).set(key, value)
		},

		triggerPipeline: async ({ serviceId, zeropsSetup }) => {
			const name = nameOf(serviceId)
			const blocked = blockedTriggers.get(name) ?? 0
			if (blocked > 0) {
				blockedTriggers.set(name, blocked - 1)
				calls.push(`blocked:${name}`)
				throw new ZeropsApiError('zerops: trigger-pipeline failed (400)', 400, 'userDataSyncRunning')
			}
			if (zeropsSetup !== name) {
				throw new Error(`zerops: setup ${zeropsSetup ?? '(none)'} does not match service ${name}`)
			}
			calls.push(`deploy:${name}`)
			const next = (sequence.get(name) ?? 0) + 1
			sequence.set(name, next)
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
			calls.push(`subdomain:${name}`)
			published.set(name, true)
		},
	}

	return {
		api,
		calls,
		env: (service) => envOf(service),
		subdomainAccess: (service) => published.get(service) === true,
		failWrite: (service, key) => void failedWrites.add(`${service}:${key}`),
		failDeploy: (service) => void failedDeploys.add(service),
		blockTrigger: (service, times) => void blockedTriggers.set(service, times),
	}
}

/** The four platform services, shaped like the live `fabrika-test` installation. */
export const platformServices = (env: Readonly<Record<string, Readonly<Record<string, string>>>> = {}): FakeServiceSpec[] => [
	{ name: 'db', id: 'svc-db' },
	{ name: 'iam', id: 'svc-iam', sequence: 4, ...(env['iam'] === undefined ? {} : { env: env['iam'] }) },
	{ name: 'operations', id: 'svc-operations', sequence: 4, ...(env['operations'] === undefined ? {} : { env: env['operations'] }) },
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
