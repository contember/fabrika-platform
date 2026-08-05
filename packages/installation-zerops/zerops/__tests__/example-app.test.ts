// The example app, driven through the REAL Zerops driver.
//
// Nothing here is a stand-in for the config: `examples/zerops-app/fabrika.config.ts` is imported as a
// package and handed to `deploy()` exactly as the control plane would hand it over. What is faked is the
// single collaborator interface the driver's effects go through (`ZeropsCollaborators`) — which is the
// whole point of that seam, and the only way to exercise the path with no account.
//
// PROVEN HERE: the plan's shape and order, the exact ordered sequence of API calls a real run makes,
// that a dry run makes NONE of them, that the compiled import is schema-valid and carries no secret, and
// that the app's gates survive a round trip into the proxy's own manifest parser and Caddy generator.
//
// NOT PROVEN: that Zerops accepts any of it. No request in this file leaves the process.

import { applicableGates, compileGates, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { deploy, type RuntimeProviderRun } from '@fabrika/engine'
import notesConfig, { NOTES_DATABASE_SERVICE, NOTES_SERVICE, NOTES_UPSTREAM } from '@fabrika/example-zerops-app'
import { notesGates } from '@fabrika/example-zerops-app/gates'
import { NOTES_APP_ID } from '@fabrika/example-zerops-app/schema'
import {
	compileFabrikaManifest,
	compileImport,
	compileImportYaml,
	createZeropsProvider,
	type ZeropsApi,
	type ZeropsAppVersionStatus,
	type ZeropsCollaborators,
	type ZeropsProvider,
	type ZeropsRuntimeTarget,
} from '@fabrika/provider-zerops'
import { buildCaddyConfig } from '@fabrika/proxy'
import { encodeProxyManifestJson, parseProxyManifestJson, type ProxyManifest } from '@fabrika/proxy-contract'
import { beforeEach, describe, expect, test } from 'bun:test'
import { assertOnlyPublicService, assertZeropsHostnames } from '../invariants'
import { validateYaml } from '../validate'

// ── the recording fake ────────────────────────────────────────────────────────────────────────────

interface Recorded {
	/** Every collaborator method invoked, in order — the sequence these tests assert on. */
	calls: string[]
	imports: Array<{ projectId: string; yaml: string }>
	triggers: Array<{ serviceId: string; buildFromGit?: string; zeropsSetup?: string }>
	schemas: Array<{ url: string; app: string }>
	logs: string[]
}

const fresh = (): Recorded => ({ calls: [], imports: [], triggers: [], schemas: [], logs: [] })

/** Statuses handed back by successive polls; the last one repeats. */
const makeApi = (rec: Recorded, statuses: ZeropsAppVersionStatus[]): ZeropsApi => {
	let poll = 0
	const record = <T>(name: string, value: T): T => {
		rec.calls.push(name)
		return value
	}
	return {
		importServices: ({ projectId, yaml }) => {
			rec.imports.push({ projectId, yaml })
			return Promise.resolve(
				record('importServices', { projectId, projectName: 'apps-prod', services: [{ id: 'svc-api', name: NOTES_SERVICE, processes: [] }] }),
			)
		},
		importProject: ({ clientId, yaml: _yaml }) => Promise.resolve(record('importProject', { projectId: clientId, projectName: 'p', services: [] })),
		triggerPipeline: ({ serviceId, buildFromGit, zeropsSetup }) => {
			rec.triggers.push({ serviceId, buildFromGit, zeropsSetup })
			return Promise.resolve(record('triggerPipeline', { id: 'proc-1', appVersionId: 'ver-1' }))
		},
		getAppVersion: ({ appVersionId }) => {
			const status = statuses[Math.min(poll, statuses.length - 1)]
			poll += 1
			return Promise.resolve(record('getAppVersion', { id: appVersionId, status }))
		},
		latestAppVersion: () => Promise.resolve(record('latestAppVersion', { id: 'ver-1', sequence: 1 })),
		cancelBuild: () => Promise.resolve(record('cancelBuild', undefined)),
		getService: ({ serviceId }) => Promise.resolve(record('getService', { id: serviceId, name: NOTES_SERVICE })),
		findService: ({ hostname }) => Promise.resolve(record('findService', { id: 'svc-api', name: hostname })),
		getProject: ({ projectId }) => Promise.resolve(record('getProject', { id: projectId, name: 'apps-prod' })),
		listProjects: () => Promise.resolve(record('listProjects', [])),
		findProjects: () => Promise.resolve(record('findProjects', [])),
		listProjectServices: () => Promise.resolve(record('listProjectServices', [])),
		listServiceEnv: () => Promise.resolve(record('listServiceEnv', [])),
		putServiceEnv: () => Promise.resolve(record('putServiceEnv', undefined)),
		deleteServiceEnv: () => Promise.resolve(record('deleteServiceEnv', undefined)),
		getProjectEnv: ({ projectEnvId }) => Promise.resolve(record('getProjectEnv', { id: projectEnvId, key: 'K', content: 'V' })),
		getLogAccess: () =>
			Promise.resolve(
				record('getLogAccess', {
					url: 'https://log.test/l',
					urlPlain: 'https://log.test/p',
					urlInfo: 'https://log.test/i',
					urlUi: 'https://log.test/u',
					accessToken: 'log-token',
					expiration: '2099-01-01T00:00:00Z',
				}),
			),
		readBuildLog: () => Promise.resolve(record('readBuildLog', [{ message: 'bun install --frozen-lockfile' }])),
	}
}

const makeCollaborators = (rec: Recorded, statuses: ZeropsAppVersionStatus[]): ZeropsCollaborators => ({
	api: makeApi(rec, statuses),
	reconcileSchema: (input) => {
		rec.calls.push('reconcileSchema')
		rec.schemas.push({ url: input.url, app: input.app })
		return Promise.resolve()
	},
	sleep: () => {
		rec.calls.push('sleep')
		return Promise.resolve()
	},
})

/**
 * The deploy's coordinates. `projectId` is the registry field ADR-0006 makes the topology decision with —
 * the `apps-prod` project this example's services are imported INTO. The token is a fake and is asserted
 * never to be logged.
 */
const TARGET: ZeropsRuntimeTarget = {
	projectId: 'proj-apps-prod',
	serviceId: 'svc-api',
	accessToken: 'zt-not-a-real-token',
	propustkaUrl: 'https://iam.example.test',
	adminKey: 'px_admin_placeholder',
}

const MANIFEST = compileFabrikaManifest(notesConfig, 'prod')

const makeRun = (provider: ZeropsProvider, recorded: Recorded, overrides: Partial<RuntimeProviderRun> = {}): RuntimeProviderRun => ({
	appId: notesConfig.id,
	env: 'prod',
	target: provider.encodeTarget(TARGET),
	artifact: provider.encodeArtifact(MANIFEST),
	secrets: {},
	vars: {},
	managedEnvironment: {},
	cwd: '/repo',
	dryRun: false,
	signal: new AbortController().signal,
	events: {
		log: (line) => {
			recorded.logs.push(line)
		},
		externalId: () => Promise.resolve(),
	},
	...overrides,
})

const deployExample = (
	recorded: Recorded,
	statuses: ZeropsAppVersionStatus[] = ['ACTIVE'],
	overrides: Partial<RuntimeProviderRun> = {},
) => {
	const provider = createZeropsProvider(() => makeCollaborators(recorded, statuses))
	return deploy(provider.runtime, makeRun(provider, recorded, overrides))
}

let rec: Recorded
beforeEach(() => {
	rec = fresh()
})

// ── the compiled import ───────────────────────────────────────────────────────────────────────────

describe('the app compiles to an import that is applied INTO an existing project', () => {
	const { document, yaml } = compileImportYaml({ target: notesConfig.target, ctx: { env: 'prod' } })

	test('it validates against the published JSON schema — zero errors', () => {
		expect(validateYaml('import', yaml)).toEqual([])
	})

	test('it declares NO project: the project id is a registry field, not a config field (ADR-0006)', () => {
		expect(document.project).toBeUndefined()
		expect(notesConfig.target.project).toBeUndefined()
		expect(yaml.startsWith('services:')).toBe(true)
	})

	test('a database and a runtime, in creation order', () => {
		expect(document.services.map((service) => service.hostname)).toEqual([NOTES_DATABASE_SERVICE, NOTES_SERVICE])
		expect(document.services[0]?.priority).toBeGreaterThan(document.services[1]?.priority ?? 0)
	})

	test('the app service is NOT publicly routed — the proxy in this project is', () => {
		expect(document.services.find((service) => service.hostname === NOTES_SERVICE)?.enableSubdomainAccess).toBe(false)
		expect(() => assertOnlyPublicService(document)).not.toThrow()
	})

	test('envIsolation is `service` on both services and no secret rides along', () => {
		expect(document.services.map((service) => service.envIsolation)).toEqual(['service', 'service'])
		expect(document.services.every((service) => service.envSecrets === undefined && service.dotEnvSecrets === undefined)).toBe(true)
		expect(yaml).not.toContain('envSecrets')
	})

	test('hostnames are legal — lowercase, no hyphens, under 25 characters', () => {
		expect(() => assertZeropsHostnames(document)).not.toThrow()
	})

	test('the database type is chosen per environment: HA in prod, single elsewhere', () => {
		const typeIn = (env: string): string | undefined =>
			compileImport({ target: notesConfig.target, ctx: { env } }).services.find((service) => service.hostname === NOTES_DATABASE_SERVICE)?.type
		expect(typeIn('prod')).toBe('postgresql:ha@18')
		expect(typeIn('stage')).toBe('postgresql:single@18')
		// Availability is in the TYPE; the deprecated `mode` is not representable.
		expect(yaml).not.toContain('mode:')
	})
})

// ── the driver ────────────────────────────────────────────────────────────────────────────────────

describe('dryRun makes NO call at all, and says what each step would have done', () => {
	test('the plan is Zerops-shaped: no build, no migrate, no sync-secrets', async () => {
		const result = await deployExample(rec, ['ACTIVE'], { dryRun: true })
		expect(result.status).toBe('succeeded')
		expect(result.plan.steps.map((step) => step.id)).toEqual(['apply-import', 'trigger-deploy', 'await-deploy', 'reconcile-schema'])
		expect(result.plan.steps.map((step) => step.kind)).toEqual(['apply-import', 'trigger-deploy', 'await-deploy', 'reconcile-schema'])
		// Every step depends on the previous one.
		expect(result.plan.steps.map((step) => step.dependsOn ?? [])).toEqual([[], ['apply-import'], ['trigger-deploy'], ['await-deploy']])
	})

	test('not one collaborator call is made', async () => {
		await deployExample(rec, ['ACTIVE'], { dryRun: true })
		expect(rec.calls).toEqual([])
	})

	test('the narrative names all four effects, in order', async () => {
		await deployExample(rec, ['ACTIVE'], { dryRun: true })
		const narrative = rec.logs.filter((line) => line.includes('[dry-run]')).map((line) => line.trim())
		expect(narrative).toEqual([
			`[dry-run] would POST the import for 2 service(s) to project ${TARGET.projectId}:`,
			`[dry-run] would trigger the Zerops pipeline for service ${TARGET.serviceId} (${NOTES_SERVICE}) from the service's configured Git integration`,
			'[dry-run] would poll /app-version until it is ACTIVE and relay the build log',
			`[dry-run] would reconcile schema for \`${NOTES_APP_ID}\` against https://iam.example.test`,
		])
	})

	test('the import it would POST is echoed in full, so a plan is reviewable without credentials', async () => {
		await deployExample(rec, ['ACTIVE'], { dryRun: true })
		const echoed = rec.logs.filter((line) => line.startsWith('  │ ')).map((line) => line.slice(4)).join('\n')
		expect(validateYaml('import', echoed)).toEqual([])
		expect(echoed).toContain(`hostname: ${NOTES_SERVICE}`)
		expect(echoed).toContain(`hostname: ${NOTES_DATABASE_SERVICE}`)
	})

	test('and the access token never reaches the log', async () => {
		await deployExample(rec, ['ACTIVE'], { dryRun: true })
		expect(rec.logs.join('\n')).not.toContain(TARGET.accessToken)
	})
})

describe('a real run makes exactly these calls, in exactly this order', () => {
	test('import → trigger → open the log → poll → relay → reconcile', async () => {
		const result = await deployExample(rec, ['BUILDING', 'DEPLOYING', 'ACTIVE'])
		expect(result.status).toBe('succeeded')
		expect(rec.calls).toEqual([
			// 1. apply the import (`override: true` makes re-applying safe)
			'importServices',
			// 2. trigger the platform's own CI — fabrika does not run the build (ADR-0003)
			'triggerPipeline',
			// 3-N. watch it. Build and deploy are ONE platform-side operation, so what fabrika splits is
			// triggering from observing.
			'getLogAccess',
			'getAppVersion',
			'readBuildLog',
			'sleep',
			'getAppVersion',
			'readBuildLog',
			'sleep',
			'getAppVersion',
			'readBuildLog',
			// N+1. the one portable step: reconcile the authz vocabulary into IAM
			'reconcileSchema',
		])
	})

	test('the import goes to the project the REGISTRY named, and carries the compiled document', async () => {
		await deployExample(rec)
		expect(rec.imports).toHaveLength(1)
		expect(rec.imports[0]?.projectId).toBe(TARGET.projectId)
		expect(validateYaml('import', rec.imports[0]?.yaml ?? '')).toEqual([])
	})

	test("the pipeline trigger selects the app's named setup from its repository-root zerops.yaml", async () => {
		await deployExample(rec)
		expect(rec.triggers).toEqual([{ serviceId: TARGET.serviceId, buildFromGit: undefined, zeropsSetup: NOTES_SERVICE }])
	})

	test("the schema reconcile names the app id the token's `aud` will carry", async () => {
		await deployExample(rec)
		expect(rec.schemas).toEqual([{ url: 'https://iam.example.test', app: NOTES_APP_ID }])
	})

	test('NO secret is pushed as part of the deploy, even though the app declares two', async () => {
		expect(notesConfig.pipeline?.secrets).toEqual(['NOTES_SESSION_PEPPER', 'NOTES_WEBHOOK_SIGNING_KEY'])
		await deployExample(rec, ['ACTIVE'], { secrets: { NOTES_SESSION_PEPPER: 'x', NOTES_WEBHOOK_SIGNING_KEY: 'y' } })
		// On Zerops the platform is the system of record; a deploy-time write would silently correct a
		// client's GUI edit (ADR-0004). So: no env write, and no `sync-secrets` step to make one.
		expect(rec.calls).not.toContain('putServiceEnv')
	})

	test('a failed pipeline fails the run and SKIPS the reconcile — a broken build never touches IAM', async () => {
		const result = await deployExample(rec, ['BUILDING', 'BUILD_FAILED'])
		expect(result.status).toBe('failed')
		expect(result.steps.find((step) => step.spec.id === 'reconcile-schema')?.status).toBe('skipped')
		expect(rec.calls).not.toContain('reconcileSchema')
	})
})

// ── gates → the proxy ─────────────────────────────────────────────────────────────────────────────

describe("the app's gates are enforced by the proxy, and survive the trip verbatim", () => {
	const manifest: ProxyManifest = {
		apps: [{ id: NOTES_APP_ID, hosts: ['notes.example.test'], upstream: NOTES_UPSTREAM, gates: notesGates, scheme: 'https' }],
	}

	test("the proxy's own strict parser accepts it, with rule ORDER preserved (order IS the precedence)", () => {
		const parsed = parseProxyManifestJson(encodeProxyManifestJson(manifest))
		expect(parsed).not.toBeNull()
		expect(parsed?.apps[0]?.gates.rules).toEqual(notesGates.rules)
		expect(parsed?.apps[0]?.upstream).toBe(`${NOTES_SERVICE}:3000`)
	})

	test('the ordered rules that apply to a path are the ones the app declared', () => {
		const compiledGates = compileGates(notesGates)
		const kinds = (path: string): string[] => applicableGates(compiledGates, path).map((gate) => `${gate.rule.kind} ${gate.rule.path}`)
		expect(kinds('/healthz')).toEqual(['public /healthz', 'human /*'])
		expect(kinds('/public/info')).toEqual(['public /public/*', 'human /*'])
		// The fall-through pair: a machine credential is tried first, a human second.
		expect(kinds('/api/notes')).toEqual(['service /api/*', 'human /api/*', 'human /*'])
		expect(kinds('/settings')).toEqual(['human /*'])
		// Case-sensitive, unlike a Caddy path matcher — which is one of ADR-0010's three reasons gates
		// are never compiled into Caddy routes.
		expect(kinds('/Public/info')).toEqual(['human /*'])
	})

	test("the generated Caddy config routes to the app's PRIVATE address and deletes the token header first", () => {
		const config = buildCaddyConfig(manifest, { authUpstream: '127.0.0.1:9000' })
		const serialized = JSON.stringify(config)
		expect(serialized).toContain(`"dial":"${NOTES_UPSTREAM}"`)
		// ADR-0010: the delete is load-bearing — `copy_headers` cannot delete, so without it a
		// client-supplied token would survive to the app on any `public` path. The request id rides
		// along for the same reason: it is written to IAM's audit trail, so only the proxy mints one.
		// The client address and its aliases join them so an upstream's abuse limit keys on what this
		// hop observed and never on what the caller claimed.
		expect(serialized).toContain(
			`"delete":["${PROXY_TOKEN_HEADER}","X-Request-Id","X-Fabrika-Client-Ip","X-Forwarded-For","CF-Connecting-IP"]`,
		)
		expect(serialized).toContain('"set":{"X-Fabrika-Client-Ip":["{http.request.client_ip}"]}')
		// Caddy's admin API is off: the manifest is baked in at build time, not pushed at runtime.
		expect(config.admin.disabled).toBe(true)
	})
})
