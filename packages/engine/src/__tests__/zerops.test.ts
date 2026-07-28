import { type AppConfig, type AppSchema, defineApp, Worker, type ZeropsAppConfig, type ZeropsServiceSpec } from '@fabrika/config'
import { beforeEach, describe, expect, test } from 'bun:test'
import { deploy, type DeployOptions } from '../deploy'
import { CANCELLED } from '../driver'
import { createZeropsDriver } from '../drivers/zerops'
import { createZeropsApi } from '../drivers/zerops/api'
import type { ZeropsApi, ZeropsAppVersion, ZeropsLogAccess } from '../drivers/zerops/api'
import type { ZeropsCollaborators } from '../drivers/zerops/collaborators'
import {
	assertZeropsInvariants,
	compileImport,
	compileImportYaml,
	compileProvisioningYaml,
	ENV_ISOLATION,
	renderImportYaml,
} from '../drivers/zerops/compile'
import type { ZeropsImportDocument } from '../drivers/zerops/compile'
import { buildZeropsPlan, resolveDeployHostname } from '../drivers/zerops/plan'
import type { DeployContext, ZeropsTarget } from '../types'

// A Zerops deploy is HTTP and nothing else (ADR-0003), so the driver is driven here over a recording FAKE
// of its single collaborator interface — no network, no clock, no platform. What these tests prove:
// the plan's SHAPE (and that it is not Cloudflare's with no-ops), ADR-0004's two invariants at every layer
// that is supposed to enforce them, `startWithoutCode`, dry-run, and cancellation.

interface Recorded {
	imports: Array<{ projectId: string; yaml: string }>
	projectImports: Array<{ clientId: string; yaml: string }>
	triggers: Array<{ serviceId: string; buildFromGit?: string; zeropsSetup?: string }>
	polls: string[]
	cancels: string[]
	envWrites: Array<{ serviceId: string; key: string }>
	logReads: number
	schemas: Array<{ url: string; app: string; adminKey?: string }>
	logs: string[]
	sleeps: number[]
}

const fresh = (): Recorded => ({
	imports: [],
	projectImports: [],
	triggers: [],
	polls: [],
	cancels: [],
	envWrites: [],
	logReads: 0,
	schemas: [],
	logs: [],
	sleeps: [],
})

interface Overrides {
	/** Statuses handed back by successive `getAppVersion` polls; the last one repeats. */
	statuses?: Array<ZeropsAppVersion['status']>
	/** The version id the trigger response carries; `undefined` forces the `latestAppVersion` fallback. */
	triggerVersionId?: string
	latestVersion?: ZeropsAppVersion | null
	logLines?: string[]
	failLogAccess?: boolean
	/** Called before each poll resolves — lets a test cancel mid-loop. */
	onPoll?: (index: number) => void
}

const LOG_ACCESS: ZeropsLogAccess = {
	url: 'https://log.example/logs',
	urlPlain: 'https://log.example/logs/plain',
	urlInfo: 'https://log.example/logs/info',
	urlUi: 'https://log.example/ui',
	accessToken: 'log-token',
	expiration: '2099-01-01T00:00:00Z',
}

/** A recording `ZeropsApi`. Every method is present so a missing one is a compile error, not a surprise. */
const makeApi = (rec: Recorded, overrides: Overrides = {}): ZeropsApi => {
	let pollIndex = 0
	return {
		importServices: async ({ projectId, yaml }) => {
			rec.imports.push({ projectId, yaml })
			return { projectId, projectName: 'proj', services: [{ id: 'svc-1', name: 'api', processes: [] }] }
		},
		importProject: async ({ clientId, yaml }) => {
			rec.projectImports.push({ clientId, yaml })
			return { projectId: 'p1', projectName: 'proj', services: [] }
		},
		triggerPipeline: async ({ serviceId, buildFromGit, zeropsSetup }) => {
			rec.triggers.push({ serviceId, buildFromGit, zeropsSetup })
			return overrides.triggerVersionId === undefined ? null : { id: 'proc-1', appVersionId: overrides.triggerVersionId }
		},
		getAppVersion: async ({ appVersionId }) => {
			const index = pollIndex
			pollIndex += 1
			rec.polls.push(appVersionId)
			overrides.onPoll?.(index)
			const statuses = overrides.statuses ?? ['ACTIVE']
			return { id: appVersionId, status: statuses[Math.min(index, statuses.length - 1)] }
		},
		latestAppVersion: async () => overrides.latestVersion ?? { id: 'ver-9', status: 'BUILDING', sequence: 9 },
		cancelBuild: async ({ appVersionId }) => {
			rec.cancels.push(appVersionId)
		},
		getService: async ({ serviceId }) => ({ id: serviceId, name: 'api' }),
		findService: async ({ hostname }) => ({ id: 'svc-1', name: hostname }),
		getProject: async ({ projectId }) => ({ id: projectId, name: 'proj' }),
		listServiceEnv: async () => [],
		putServiceEnv: async ({ serviceId, key }) => {
			rec.envWrites.push({ serviceId, key })
		},
		deleteServiceEnv: async () => {},
		getProjectEnv: async ({ projectEnvId }) => ({ id: projectEnvId, key: 'K', content: 'V' }),
		getLogAccess: async () => {
			if (overrides.failLogAccess === true) {
				throw new Error('log service unavailable')
			}
			return LOG_ACCESS
		},
		readBuildLog: async () => {
			rec.logReads += 1
			return (overrides.logLines ?? []).map((message) => ({ message }))
		},
	}
}

const makeCollaborators = (rec: Recorded, overrides: Overrides = {}): ZeropsCollaborators => ({
	api: makeApi(rec, overrides),
	reconcileSchema: async (input) => {
		rec.schemas.push({ url: input.url, app: input.app, adminKey: input.adminKey })
	},
	sleep: async (ms) => {
		rec.sleeps.push(ms)
	},
})

const makeOptions = (rec: Recorded, overrides: Overrides = {}, signal?: AbortSignal): DeployOptions => ({
	log: (line) => {
		rec.logs.push(line)
	},
	drivers: { zerops: createZeropsDriver(() => makeCollaborators(rec, overrides)) },
	...(signal !== undefined ? { signal } : {}),
})

const SCHEMA: AppSchema = { scopes: [], actions: [], roles: {} }

const API: ZeropsServiceSpec = { hostname: 'api', type: 'alpine/bun@1.3' }
const DB: ZeropsServiceSpec = { hostname: 'db', type: 'postgresql:single@18', priority: 10 }

const makeConfig = (overrides: Partial<ZeropsAppConfig> = {}, services: ZeropsServiceSpec[] = [API]): ZeropsAppConfig =>
	defineApp({
		id: 'demo',
		target: { platform: 'zerops', services: () => services },
		...overrides,
	})

const makeTarget = (overrides: Partial<ZeropsTarget> = {}): ZeropsTarget => ({
	platform: 'zerops',
	projectId: 'proj-1',
	serviceId: 'svc-1',
	accessToken: 'zt-secret',
	...overrides,
})

const makeCtx = (overrides: Partial<DeployContext<ZeropsTarget>> = {}): DeployContext<ZeropsTarget> => ({
	env: 'stage',
	target: makeTarget(),
	secrets: {},
	cwd: '/work',
	...overrides,
})

let rec: Recorded
beforeEach(() => {
	rec = fresh()
})

describe('the config surface', () => {
	test('defineApp still accepts the Cloudflare arm unchanged, and its type stays `AppConfig`', () => {
		const config: AppConfig = defineApp({
			id: 'cf-app',
			resources: () => new Worker({ dir: '.', name: 'cf-app', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		expect(typeof config.resources).toBe('function')
	})

	test('defineApp accepts the Zerops arm and keeps the declaration reachable', () => {
		const config = makeConfig({}, [DB, API])
		expect(config.target.platform).toBe('zerops')
		expect(config.target.services({ env: 'stage' }).map((service) => service.hostname)).toEqual(['db', 'api'])
	})

	test('a config and a target for DIFFERENT platforms is rejected before any driver sees the run', async () => {
		const cloudflareConfig = defineApp({
			id: 'cf-app',
			resources: () => new Worker({ dir: '.', name: 'cf-app', compatibility_flags: [], bindings: {}, main: 'src/index.ts' }),
		})
		await expect(deploy(cloudflareConfig, makeCtx(), makeOptions(rec))).rejects.toThrow(
			'declares a `cloudflare` target but the deploy targets `zerops`',
		)
		expect(rec.imports).toEqual([])
	})
})

describe('plan derivation — the Zerops plan is a DIFFERENT SHAPE, not Cloudflare with no-ops', () => {
	test('minimal config: apply-import → trigger-deploy → await-deploy', async () => {
		const result = await deploy(makeConfig(), makeCtx(), makeOptions(rec))
		expect(result.plan.steps.map((step) => step.kind)).toEqual(['apply-import', 'trigger-deploy', 'await-deploy'])
	})

	test('reconcile-schema is appended when the app has a schema and propustka coords — the ONE portable step', async () => {
		const result = await deploy(makeConfig({ schema: SCHEMA }), makeCtx({ propustkaUrl: 'https://iam.test', adminKey: 'px_k' }), makeOptions(rec))
		expect(result.plan.steps.map((step) => step.id)).toEqual(['apply-import', 'trigger-deploy', 'await-deploy', 'reconcile-schema'])
		expect(rec.schemas).toEqual([{ url: 'https://iam.test', app: 'demo', adminKey: 'px_k' }])
	})

	test('NO sync-secrets step exists, even for an app that declares secrets — on Zerops that is not a deploy step (ADR-0004)', async () => {
		const config = makeConfig({ pipeline: { secrets: ['API_KEY', 'DB_PASSWORD'] } })
		const result = await deploy(config, makeCtx({ secrets: { API_KEY: 'a', DB_PASSWORD: 'b' } }), makeOptions(rec))
		expect(result.status).toBe('succeeded')
		expect(result.plan.steps.map((step) => step.kind)).not.toContain('sync-secrets')
		// And nothing wrote an environment variable as part of the deploy.
		expect(rec.envWrites).toEqual([])
	})

	test('NO build / migrate / deploy-worker steps — Zerops owns the build, migrations are a container-start hook', async () => {
		const config = makeConfig({ pipeline: { build: 'bun run build' } })
		const result = await deploy(config, makeCtx(), makeOptions(rec))
		const kinds = result.plan.steps.map((step) => step.kind)
		expect(kinds).not.toContain('build')
		expect(kinds).not.toContain('migrate')
		expect(kinds).not.toContain('deploy-worker')
		expect(kinds).not.toContain('provision-resources')
	})

	test('dependsOn chains every step to the previous one', () => {
		const plan = buildZeropsPlan(makeConfig({ schema: SCHEMA }), makeCtx({ propustkaUrl: 'https://iam.test' }), ['api'])
		expect(plan.steps[0]?.dependsOn).toBeUndefined()
		expect(plan.steps[1]?.dependsOn).toEqual(['apply-import'])
		expect(plan.steps[3]?.dependsOn).toEqual(['await-deploy'])
	})

	test('a multi-service app must name which service carries the code', () => {
		const target = makeConfig({}, [DB, API]).target
		expect(() => resolveDeployHostname(target, ['db', 'api'])).toThrow('set `deployService`')
		expect(resolveDeployHostname({ ...target, deployService: 'api' }, ['db', 'api'])).toBe('api')
		expect(() => resolveDeployHostname({ ...target, deployService: 'nope' }, ['db', 'api'])).toThrow('names no declared service')
	})
})

describe('ADR-0004 invariant 1 — an app secret NEVER reaches project-level env', () => {
	test('the compiled project section has no envVariables, at any layer', () => {
		const config = makeConfig({ target: { platform: 'zerops', services: () => [API], project: { name: 'apps-stage', corePackage: 'LIGHT' } } })
		const { document, yaml } = compileImportYaml({ target: config.target, ctx: { env: 'stage' } })
		expect(document.project?.envVariables).toBeUndefined()
		expect(yaml).not.toContain('envVariables')
	})

	test('a project-level envVariables that arrives from an untyped source is REJECTED, not dropped silently', () => {
		const document: ZeropsImportDocument = {
			project: { name: 'apps-stage', envIsolation: ENV_ISOLATION, envVariables: { LEAKED: 'value' } },
			services: [{ hostname: 'api', type: 'alpine/bun@1.3', envIsolation: ENV_ISOLATION, override: true }],
		}
		expect(() => assertZeropsInvariants(document)).toThrow('PROJECT-level env variables')
		expect(() => renderImportYaml(document)).toThrow('PROJECT-level env variables')
	})

	test('secret VALUES never travel in the import document — a service carrying envSecrets is rejected', () => {
		const document: ZeropsImportDocument = {
			services: [{ hostname: 'api', type: 'alpine/bun@1.3', envIsolation: ENV_ISOLATION, override: true, envSecrets: { API_KEY: 'hunter2' } }],
		}
		expect(() => assertZeropsInvariants(document)).toThrow('carries secrets in the import document')
		// The rejection message must not echo the value it refused to ship.
		expect(() => assertZeropsInvariants(document)).not.toThrow('hunter2')
	})

	test('the API client exposes NO way to write a project-level variable — the invariant is the absent method', () => {
		const api = createZeropsApi({ token: 'zt', fetchImpl: () => Promise.reject(new Error('no network in tests')) })
		const methods = Object.keys(api)
		expect(methods).toContain('putServiceEnv')
		expect(methods.filter((name) => /project.*env/i.test(name))).toEqual(['getProjectEnv'])
		expect(methods.some((name) => /^(put|post|set|create|delete)Project/i.test(name))).toBe(false)
	})
})

describe('ADR-0004 invariant 2 — envIsolation is ALWAYS `service`, explicitly', () => {
	test('every compiled service carries envIsolation: service, whatever the app declared', () => {
		const { document } = compileImportYaml({ target: makeConfig({}, [DB, API]).target, ctx: { env: 'stage' } })
		expect(document.services.map((service) => service.envIsolation)).toEqual(['service', 'service'])
	})

	test('the compiled project carries envIsolation: service — never left to a platform default', () => {
		const target = makeConfig({ target: { platform: 'zerops', services: () => [API], project: { name: 'apps-stage' } } }).target
		const { document, yaml } = compileImportYaml({ target, ctx: { env: 'stage' } })
		expect(document.project?.envIsolation).toBe('service')
		expect(yaml).toContain('envIsolation: service')
	})

	test('`envIsolation: none` anywhere in a finished document is REJECTED — that setting is the leak', () => {
		const projectLevel: ZeropsImportDocument = {
			project: { name: 'p', envIsolation: 'none' },
			services: [{ hostname: 'api', type: 'alpine/bun@1.3', envIsolation: ENV_ISOLATION, override: true }],
		}
		expect(() => assertZeropsInvariants(projectLevel)).toThrow('project envIsolation must be `service`')

		const serviceLevel: ZeropsImportDocument = {
			services: [{ hostname: 'api', type: 'alpine/bun@1.3', envIsolation: 'none', override: true }],
		}
		expect(() => assertZeropsInvariants(serviceLevel)).toThrow('service `api` envIsolation must be `service`')
	})

	test('a service that simply omits envIsolation is rejected too — a default is not good enough', () => {
		const document: ZeropsImportDocument = { services: [{ hostname: 'api', type: 'alpine/bun@1.3', override: true }] }
		expect(() => assertZeropsInvariants(document)).toThrow('envIsolation must be `service`')
	})

	test('the invariants are asserted at OPEN, before any request is made', async () => {
		// A config whose services() smuggles in a project-level leak by way of a hand-built document is not
		// typeable; the reachable failure is a duplicate hostname, which must also stop the run before I/O.
		const config = makeConfig({}, [API, { ...API, type: 'alpine/bun@1.3' }])
		await expect(deploy(config, makeCtx(), makeOptions(rec))).rejects.toThrow('duplicate service hostname')
		expect(rec.imports).toEqual([])
		expect(rec.triggers).toEqual([])
	})
})

describe('compilation + YAML', () => {
	test('override: true on every service — the idempotency lever the apply-import step rests on', () => {
		const { document } = compileImportYaml({ target: makeConfig({}, [DB, API]).target, ctx: { env: 'stage' } })
		expect(document.services.every((service) => service.override === true)).toBe(true)
	})

	test('renders a document Zerops can read: two top-level keys, quoted where needed, block scalars for multi-line', () => {
		const target = makeConfig({
			target: {
				platform: 'zerops',
				services:
					() => [{ hostname: 'api', type: 'alpine/bun@1.3', priority: 10, enableSubdomainAccess: false, nginxConfig: 'server {\n  listen 80;\n}' }],
				project: { name: 'apps stage', corePackage: 'SERIOUS', tags: ['fabrika'] },
			},
		}).target
		const { yaml } = compileImportYaml({ target, ctx: { env: 'stage' } })
		expect(yaml).toContain('project:')
		expect(yaml).toContain('  name: "apps stage"')
		expect(yaml).toContain('  corePackage: SERIOUS')
		expect(yaml).toContain('    - fabrika')
		expect(yaml).toContain('services:')
		expect(yaml).toContain('  - hostname: api')
		expect(yaml).toContain('    priority: 10')
		expect(yaml).toContain('    enableSubdomainAccess: false')
		expect(yaml).toContain('    nginxConfig: |-')
		expect(yaml).toContain('      server {')
	})

	test('the ctx reaches services() so a config can shape a stage differently', () => {
		const target = makeConfig({
			target: { platform: 'zerops', services: (ctx) => [{ hostname: `api${ctx.env === 'prod' ? '' : 'stage'}`, type: 'alpine/bun@1.3' }] },
		}).target
		expect(compileImport({ target, ctx: { env: 'prod' } }).services[0]?.hostname).toBe('api')
		expect(compileImport({ target, ctx: { env: 'stage' } }).services[0]?.hostname).toBe('apistage')
	})
})

describe('startWithoutCode — provisioning a service before it has code (ADR-0004 gap)', () => {
	test('the provisioning compile forces startWithoutCode on every service', () => {
		const { document, yaml } = compileProvisioningYaml({ target: makeConfig({}, [DB, API]).target, ctx: { env: 'stage' } })
		expect(document.services.map((service) => service.startWithoutCode)).toEqual([true, true])
		expect(yaml).toContain('startWithoutCode: true')
	})

	test('an app may also declare it per service, and the import-level flag wins', () => {
		const services: ZeropsServiceSpec[] = [{ ...API, startWithoutCode: false }]
		expect(compileImport({ target: makeConfig({}, services).target, ctx: { env: 'stage' } }).services[0]?.startWithoutCode).toBe(false)
		expect(compileImport({ target: makeConfig({}, services).target, ctx: { env: 'stage' }, startWithoutCode: true }).services[0]?.startWithoutCode)
			.toBe(true)
	})

	test('a normal deploy does NOT force it — the flag belongs to provisioning, not to deploying', async () => {
		await deploy(makeConfig(), makeCtx(), makeOptions(rec))
		expect(rec.imports[0]?.yaml).not.toContain('startWithoutCode')
	})
})

describe('execution', () => {
	test("apply-import posts the compiled YAML to the run's project", async () => {
		const result = await deploy(makeConfig(), makeCtx(), makeOptions(rec))
		expect(result.status).toBe('succeeded')
		expect(rec.imports).toHaveLength(1)
		expect(rec.imports[0]?.projectId).toBe('proj-1')
		expect(rec.imports[0]?.yaml).toContain('hostname: api')
	})

	test('trigger-deploy passes buildFromGit + zeropsSetup and resolves the app-version from the trigger response', async () => {
		const config = makeConfig({ target: { platform: 'zerops', services: () => [API], zeropsSetup: 'api' } })
		await deploy(
			config,
			makeCtx({ target: makeTarget({ buildFromGit: 'https://github.com/acme/app' }) }),
			makeOptions(rec, { triggerVersionId: 'ver-1' }),
		)
		expect(rec.triggers).toEqual([{ serviceId: 'svc-1', buildFromGit: 'https://github.com/acme/app', zeropsSetup: 'api' }])
		expect(rec.polls).toEqual(['ver-1'])
	})

	test('when the trigger response carries no app-version, the newest version of the service is used instead', async () => {
		await deploy(makeConfig(), makeCtx(), makeOptions(rec, { latestVersion: { id: 'ver-7', sequence: 7 } }))
		expect(rec.polls).toEqual(['ver-7'])
	})

	test('await-deploy polls until ACTIVE, sleeping between iterations', async () => {
		const result = await deploy(makeConfig(), makeCtx(), makeOptions(rec, { statuses: ['WAITING_TO_BUILD', 'BUILDING', 'DEPLOYING', 'ACTIVE'] }))
		expect(result.status).toBe('succeeded')
		expect(rec.polls).toHaveLength(4)
		expect(rec.sleeps).toEqual([3000, 3000, 3000])
	})

	test('a failed pipeline fails the step and skips the rest', async () => {
		const config = makeConfig({ schema: SCHEMA })
		const result = await deploy(config, makeCtx({ propustkaUrl: 'https://iam.test' }), makeOptions(rec, { statuses: ['BUILDING', 'BUILD_FAILED'] }))
		expect(result.status).toBe('failed')
		expect(result.steps.find((step) => step.spec.id === 'await-deploy')?.error).toContain('BUILD_FAILED')
		expect(result.steps.find((step) => step.spec.id === 'reconcile-schema')?.status).toBe('skipped')
		expect(rec.schemas).toEqual([])
	})

	test('a version that became BACKUP is reported as superseded, not as success', async () => {
		const result = await deploy(makeConfig(), makeCtx(), makeOptions(rec, { statuses: ['BACKUP'] }))
		expect(result.steps.find((step) => step.spec.id === 'await-deploy')?.error).toContain('superseded')
	})

	test('build-log lines are relayed into the run, de-duplicated across polls', async () => {
		await deploy(makeConfig(), makeCtx(), makeOptions(rec, { statuses: ['BUILDING', 'ACTIVE'], logLines: ['installing deps', 'building'] }))
		expect(rec.logReads).toBe(2)
		expect(rec.logs.filter((line) => line.includes('installing deps'))).toHaveLength(1)
		expect(rec.logs.filter((line) => line.includes('building'))).toHaveLength(1)
	})

	test('an unavailable log service NEVER fails the deploy — the endpoint shape is unverified', async () => {
		const result = await deploy(makeConfig(), makeCtx(), makeOptions(rec, { failLogAccess: true }))
		expect(result.status).toBe('succeeded')
		expect(rec.logs.some((line) => line.includes('build-log relay unavailable'))).toBe(true)
	})
})

describe('dryRun', () => {
	test('skips EVERY mutation and logs what it would do', async () => {
		const config = makeConfig({ schema: SCHEMA })
		const result = await deploy(config, makeCtx({ dryRun: true, propustkaUrl: 'https://iam.test' }), makeOptions(rec))
		expect(result.status).toBe('succeeded')
		expect(rec.imports).toEqual([])
		expect(rec.triggers).toEqual([])
		expect(rec.polls).toEqual([])
		expect(rec.schemas).toEqual([])
		expect(rec.logs.some((line) => line.includes('[dry-run] would POST the import'))).toBe(true)
		expect(rec.logs.some((line) => line.includes('[dry-run] would trigger the Zerops pipeline'))).toBe(true)
		expect(rec.logs.some((line) => line.includes('[dry-run] would poll /app-version'))).toBe(true)
		expect(rec.logs.some((line) => line.includes('[dry-run] would reconcile schema'))).toBe(true)
	})

	test('the dry-run still compiles the document, so an invariant violation is caught without credentials', async () => {
		await expect(deploy(makeConfig({}, [API, API]), makeCtx({ dryRun: true }), makeOptions(rec))).rejects.toThrow('duplicate service hostname')
	})

	test('never logs the access token', async () => {
		await deploy(makeConfig(), makeCtx({ dryRun: true }), makeOptions(rec))
		expect(rec.logs.join('\n')).not.toContain('zt-secret')
	})
})

describe('cancellation', () => {
	test('a run cancelled before a step starts fails it with `deploy cancelled` and skips the rest', async () => {
		const controller = new AbortController()
		controller.abort()
		const result = await deploy(makeConfig(), makeCtx(), makeOptions(rec, {}, controller.signal))
		expect(result.status).toBe('failed')
		expect(result.steps.every((step) => step.status === 'skipped')).toBe(true)
		expect(rec.imports).toEqual([])
	})

	test('cancelling mid-poll stops the loop AND asks Zerops to cancel the build it started', async () => {
		const controller = new AbortController()
		const driver = createZeropsDriver(() =>
			makeCollaborators(rec, {
				statuses: ['BUILDING'],
				triggerVersionId: 'ver-1',
				onPoll: (index) => {
					if (index === 1) {
						controller.abort()
					}
				},
			})
		)
		const session = await driver.open({
			config: makeConfig(),
			ctx: makeCtx(),
			log: (line) => rec.logs.push(line),
			signal: controller.signal,
			dryRun: false,
		})
		await session.execute('trigger-deploy')
		await expect(session.execute('await-deploy')).rejects.toThrow(CANCELLED)
		// Two polls happened (the second aborted), then the loop saw the abort and cancelled the build.
		expect(rec.polls).toEqual(['ver-1', 'ver-1'])
		expect(rec.cancels).toEqual(['ver-1'])
	})

	test('a cancelled run leaves the platform-side build cancelled rather than burning the pipeline hour', async () => {
		const controller = new AbortController()
		const options = makeOptions(rec, { statuses: ['BUILDING'], triggerVersionId: 'ver-1', onPoll: () => controller.abort() }, controller.signal)
		const result = await deploy(makeConfig(), makeCtx(), options)
		expect(result.status).toBe('failed')
		expect(result.steps.find((step) => step.spec.id === 'await-deploy')?.error).toBe(CANCELLED)
	})
})
