// What the two generated topologies are asserted to be.
//
// Read the boundary carefully, because it is the whole value of this file: these tests prove the
// documents are WELL-FORMED against Zerops' published contract and that every invariant the ADRs
// require holds in them. They prove NOTHING about whether the platform accepts them, whether the
// services boot, or whether anything is reachable. Nobody has run this against a real account.

import notesConfig, { NOTES_DATABASE_SERVICE, NOTES_SERVICE } from '@fabrika/example-zerops-app'
import cheapNotesConfig from '@fabrika/example-zerops-app/cheap'
import { compileFabrikaManifest, compileImport, renderYaml, type ZeropsImportDocument } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Artifact, generatedArtifacts, REPO_ROOT } from '../artifacts'
import { assertCorePackageIsExplicit, assertOnlyPublicService, assertZeropsHostnames } from '../invariants'
import { appsTopology, compileTopology, fabrikaTopologies, platformTopology, PROXY_HOSTNAME } from '../topology'
import { validateYaml } from '../validate'

const compiled = fabrikaTopologies().map((topology) => compileTopology(topology, 'prod'))

const documents = (): Array<{ label: string; document: ZeropsImportDocument; publicService: string }> =>
	compiled.flatMap((entry) => [
		{ label: `${entry.topology.id} (provision)`, document: entry.provision.document, publicService: entry.topology.publicService },
		{ label: `${entry.topology.id} (steady)`, document: entry.steady.document, publicService: entry.topology.publicService },
	])

const platform = compiled.find((entry) => entry.topology.id === 'platform')
const light = compiled.find((entry) => entry.topology.id === 'platform-light')
const apps = compiled.find((entry) => entry.topology.id === 'apps-prod')

const importArtifacts = (): Artifact[] => generatedArtifacts().filter((artifact) => artifact.path.endsWith('.zerops-import.yaml'))

describe('every generated import document validates against the PUBLISHED JSON schema', () => {
	for (const artifact of importArtifacts()) {
		test(`${artifact.path} — zero errors`, () => {
			expect(validateYaml('import', artifact.content)).toEqual([])
		})
	}

	test('all six documents exist — provisioning and steady state, for both tiers and the apps project', () => {
		expect(importArtifacts().map((artifact) => artifact.path)).toEqual([
			'packages/installation-zerops/zerops/generated/platform.provision.zerops-import.yaml',
			'packages/installation-zerops/zerops/generated/platform.zerops-import.yaml',
			'packages/installation-zerops/zerops/generated/platform-light.provision.zerops-import.yaml',
			'packages/installation-zerops/zerops/generated/platform-light.zerops-import.yaml',
			'packages/installation-zerops/zerops/generated/apps-prod.provision.zerops-import.yaml',
			'packages/installation-zerops/zerops/generated/apps-prod.zerops-import.yaml',
		])
	})
})

describe('the topology is the one ADR-0006 describes', () => {
	test('platform: control, Operations, IAM, proxy, and isolated data services — in one project of their own', () => {
		expect(platform?.steady.document.services.map((service) => service.hostname)).toEqual([
			'db',
			'storage',
			'operationsdb',
			'operationsstorage',
			'iam',
			'operations',
			'control',
			'proxy',
		])
		expect(platform?.steady.document.project?.name).toBe('platform')
	})

	test('apps-prod is a SEPARATE project holding only the proxy — apps arrive as their own imports', () => {
		expect(apps?.steady.document.services.map((service) => service.hostname)).toEqual([PROXY_HOSTNAME])
		expect(apps?.steady.document.project?.name).toBe('apps-prod')
	})

	test('corePackage is stated explicitly on all three — it cannot be downgraded, so a default is a decision nobody made', () => {
		expect(platform?.steady.document.project?.corePackage).toBe('SERIOUS')
		expect(light?.steady.document.project?.corePackage).toBe('LIGHT')
		expect(apps?.steady.document.project?.corePackage).toBe('SERIOUS')
		const noCorePackage: ZeropsImportDocument = { project: { name: 'p', envIsolation: 'service' }, services: [] }
		expect(() => assertCorePackageIsExplicit(noCorePackage)).toThrow('must state its corePackage')
	})

	test('Postgres availability is encoded in the TYPE, and the deprecated `mode` appears nowhere', () => {
		const db = platform?.steady.document.services.find((service) => service.hostname === 'db')
		expect(db?.type).toBe('postgresql:ha@18')
		expect(db?.mode).toBeUndefined()
		expect(platform?.steady.yaml).not.toContain('mode:')
	})

	test("object storage is private and un-CDN'd — a run log can quote a build environment", () => {
		const storage = platform?.steady.document.services.find((service) => service.hostname === 'storage')
		expect(storage?.objectStoragePolicy).toBe('private')
		expect(storage?.enableCdn).toBe(false)
		const operationsStorage = platform?.steady.document.services.find((service) => service.hostname === 'operationsstorage')
		expect(operationsStorage?.objectStoragePolicy).toBe('private')
		expect(operationsStorage?.enableCdn).toBe(false)
	})

	test('the light tier is the same six roles on ONE database and ONE bucket', () => {
		expect(light?.steady.document.services.map((service) => service.hostname)).toEqual([
			'db',
			'storage',
			'iam',
			'operations',
			'control',
			'proxy',
		])
		// The point of the tier: no `operationsdb`, no `operationsstorage`. Which schema and which key
		// prefix each service uses is per-installation configuration, not a second data service.
		expect(light?.steady.document.services.some((service) => service.hostname.startsWith('operations') && service.hostname !== 'operations'))
			.toBe(false)
	})

	test('the light tier trades availability, not isolation: single Postgres, one container, still private', () => {
		const services = new Map(light?.steady.document.services.map((service) => [service.hostname, service]))
		expect(services.get('db')?.type).toBe('postgresql:single@18')
		expect(services.get('db')?.mode).toBeUndefined()
		expect(services.get('storage')?.objectStoragePolicy).toBe('private')
		expect(services.get('storage')?.enableCdn).toBe(false)
		for (const hostname of ['iam', 'operations', 'control', 'proxy']) {
			expect(services.get(hostname)?.minContainers).toBe(1)
		}
		// Everything but the proxy stays off the internet, exactly as on the standard tier.
		for (const hostname of ['iam', 'operations', 'control']) {
			expect(services.get(hostname)?.enableSubdomainAccess).toBe(false)
		}
	})

	test('Operations has an isolated HA database and no public route of its own', () => {
		const operationsDb = platform?.steady.document.services.find((service) => service.hostname === 'operationsdb')
		const operations = platform?.steady.document.services.find((service) => service.hostname === 'operations')
		expect(operationsDb?.type).toBe('postgresql:ha@18')
		expect(operations?.enableSubdomainAccess).toBe(false)
	})

	test('the database and the object store are created FIRST (priority is descending)', () => {
		const byHostname = new Map(platform?.steady.document.services.map((service) => [service.hostname, service.priority ?? 0]))
		expect(byHostname.get('db')).toBe(100)
		expect(byHostname.get('storage')).toBe(100)
		expect(byHostname.get('operationsdb')).toBe(100)
		expect(byHostname.get('operationsstorage')).toBe(100)
		expect(byHostname.get('iam')).toBeGreaterThan(byHostname.get('operations') ?? 0)
		expect(byHostname.get('operations')).toBeGreaterThan(byHostname.get('control') ?? 0)
		expect(byHostname.get('proxy')).toBeLessThan(byHostname.get('iam') ?? 0)
	})
})

describe('ADR-0004 — isolation and the absence of secrets, on the FINISHED documents', () => {
	for (const { label, document } of documents()) {
		test(`${label}: envIsolation is \`service\` at the project level and on every service`, () => {
			expect(document.project?.envIsolation).toBe('service')
			expect(document.services.map((service) => service.envIsolation)).toEqual(document.services.map(() => 'service'))
		})

		test(`${label}: no project-level env variables — they reach every service in the project`, () => {
			expect(document.project?.envVariables).toBeUndefined()
		})

		test(`${label}: no secret values travel in the document`, () => {
			expect(document.services.every((service) => service.envSecrets === undefined && service.dotEnvSecrets === undefined)).toBe(true)
		})

		test(`${label}: every service carries \`override: true\`, which is what makes re-applying idempotent`, () => {
			expect(document.services.every((service) => service.override === true)).toBe(true)
		})
	}

	test('the YAML text itself never contains an isolation setting other than `service`', () => {
		for (const artifact of importArtifacts()) {
			expect(artifact.content).not.toContain('envIsolation: none')
			expect(artifact.content).toContain('envIsolation: service')
		}
	})
})

describe('ADR-0007 — the proxy is the only publicly routed service', () => {
	for (const { label, document, publicService } of documents()) {
		test(`${label}: only the declared public service may be routed, and every runtime service states its answer`, () => {
			// The generalization the light tier forces: `platform` and `apps-prod` publish through a custom
			// domain and so route NOTHING from the import, while `platform-light` is a single-project
			// installation with no second project to put a domain in front of and takes the subdomain. The
			// invariant was never "nothing is public" — it is ADR-0007's "only the proxy", which is what
			// `publicService` names and what `assertOnlyPublicService` enforces.
			const routed = document.services.filter((service) => service.enableSubdomainAccess === true).map((service) => service.hostname)
			expect(routed.every((hostname) => hostname === publicService)).toBe(true)
			expect(() => assertOnlyPublicService(document, publicService)).not.toThrow()
			// The runtime services state their answer rather than relying on the platform default, so
			// enabling it is a visible diff and the re-applied import corrects a GUI change.
			for (const hostname of ['iam', 'control', 'proxy']) {
				const service = document.services.find((entry) => entry.hostname === hostname)
				if (service !== undefined) {
					expect(service.enableSubdomainAccess).toBe(hostname === publicService ? routed.includes(hostname) : false)
				}
			}
		})
	}

	test('the standard platform routes nothing from the import — its domain is bound out of band', () => {
		expect(platform?.steady.document.services.filter((service) => service.enableSubdomainAccess === true)).toEqual([])
	})

	test('the light platform routes the proxy and nothing else', () => {
		expect(light?.steady.document.services.filter((service) => service.enableSubdomainAccess === true).map((service) => service.hostname))
			.toEqual([PROXY_HOSTNAME])
	})

	test('the `zerops-subdomain` variant enables it on the PROXY and on nothing else', () => {
		const document = compileImport({ target: platformTopology({ env: 'dev', publicAccess: 'zerops-subdomain' }).target, ctx: { env: 'dev' } })
		expect(document.services.filter((service) => service.enableSubdomainAccess === true).map((service) => service.hostname)).toEqual([PROXY_HOSTNAME])
		expect(() => assertOnlyPublicService(document, PROXY_HOSTNAME)).not.toThrow()
	})

	test('and the check BITES: a document that opens up the IAM service is rejected', () => {
		const document: ZeropsImportDocument = {
			services: [
				{ hostname: 'proxy', type: 'alpine@3.21', envIsolation: 'service', override: true, enableSubdomainAccess: true },
				{ hostname: 'iam', type: 'alpine/bun@1.3', envIsolation: 'service', override: true, enableSubdomainAccess: true },
			],
		}
		expect(() => assertOnlyPublicService(document, 'proxy')).toThrow('service `iam` enables public subdomain access')
	})

	test('naming a public service that is not in the document is an error, not a silent pass', () => {
		expect(() => assertOnlyPublicService({ services: [{ hostname: 'api', type: 'alpine/bun@1.3', envIsolation: 'service' }] }, 'proxy')).toThrow(
			'declares no such service',
		)
	})
})

describe("hostnames — the rule that lives only in the schema's prose", () => {
	test('every generated hostname is legal', () => {
		for (const { document } of documents()) {
			expect(() => assertZeropsHostnames(document)).not.toThrow()
		}
	})

	test('a hyphen is illegal, and nothing in the published schema would have caught it', () => {
		const document: ZeropsImportDocument = { services: [{ hostname: 'run-logs', type: 'object-storage', envIsolation: 'service' }] }
		// The schema is perfectly happy with it — there is no `pattern` keyword anywhere in the document.
		expect(validateYaml('import', 'services:\n  - hostname: run-logs\n    type: object-storage\n')).toEqual([])
		expect(() => assertZeropsHostnames(document)).toThrow('is illegal')
	})

	test('26 characters is illegal', () => {
		expect(() => assertZeropsHostnames({ services: [{ hostname: 'a'.repeat(26), type: 'alpine/bun@1.3', envIsolation: 'service' }] })).toThrow(
			'is illegal',
		)
	})
})

describe('provisioning vs steady state', () => {
	test('the provisioning form starts EVERY service without code, so secrets can be written before any build', () => {
		for (const entry of compiled) {
			expect(entry.provision.document.services.map((service) => service.startWithoutCode)).toEqual(entry.provision.document.services.map(() => true))
		}
	})

	test('the steady-state form does not — `startWithoutCode` belongs to provisioning, not to deploying', () => {
		for (const entry of compiled) {
			expect(entry.steady.yaml).not.toContain('startWithoutCode')
		}
	})

	test('the two forms differ ONLY in that flag', () => {
		for (const entry of compiled) {
			expect(entry.provision.yaml.replaceAll('\n    startWithoutCode: true', '')).toBe(entry.steady.yaml)
		}
	})
})

describe('a per-environment apps project is one call away', () => {
	test('staging gets its own project, its own name and its own corePackage', () => {
		const staging = appsTopology({ env: 'stage', corePackage: 'LIGHT' })
		const { document } = compileTopology(staging, 'stage').steady
		expect(staging.id).toBe('apps-stage')
		expect(document.project?.name).toBe('apps-stage')
		expect(document.project?.corePackage).toBe('LIGHT')
		// The point of ADR-0006: this is a DIFFERENT project, so nothing in it can reach production's db.
		expect(document.project?.name).not.toBe(apps?.steady.document.project?.name)
	})
})

describe('cheap, mid, and full namespace fixtures', () => {
	test('cheap owns one shared Postgres service and the app imports only its runtime', () => {
		const namespace = compileTopology(
			appsTopology({ env: 'prod', corePackage: 'SERIOUS', preset: 'cheap', projectName: 'cheap-prod' }),
			'prod',
		)
		const app = compileFabrikaManifest(cheapNotesConfig, 'prod')

		expect(namespace.steady.document.services.map((service) => service.hostname)).toEqual(['postgres', PROXY_HOSTNAME])
		expect(namespace.steady.document.services.find((service) => service.hostname === 'postgres')?.type).toBe('postgresql:ha@18')
		expect(app.target.importDocument.services.map((service) => service['hostname'])).toEqual([NOTES_SERVICE])
		expect(app.target.namespaceResources).toEqual([{
			resourceKey: 'service:postgres',
			hostname: 'postgres',
			connectionString: '${postgres_connectionString}',
		}])
		expect(validateYaml('import', renderYaml(app.target.importDocument))).toEqual([])
	})

	test('cheap uses single-node Postgres outside production unless policy overrides it', () => {
		const namespace = compileTopology(
			appsTopology({ env: 'stage', corePackage: 'LIGHT', preset: 'cheap', projectName: 'cheap-stage' }),
			'stage',
		)
		expect(namespace.steady.document.services.find((service) => service.hostname === 'postgres')?.type).toBe('postgresql:single@18')
	})

	test('mid owns only the proxy while the app imports its prefixed database and runtime', () => {
		const namespace = compileTopology(
			appsTopology({ env: 'prod', corePackage: 'SERIOUS', preset: 'mid' }),
			'prod',
		)
		const app = compileFabrikaManifest(notesConfig, 'prod')

		expect(namespace.topology.namespacePreset).toBe('mid')
		expect(namespace.steady.document.services.map((service) => service.hostname)).toEqual([PROXY_HOSTNAME])
		expect(app.target.importDocument.services.map((service) => service['hostname'])).toEqual([NOTES_DATABASE_SERVICE, NOTES_SERVICE])
		expect(app.target.namespaceResources).toBeUndefined()
	})

	test('full uses the same app-owned services but reserves the namespace for that app', () => {
		const namespace = compileTopology(
			appsTopology({
				env: 'prod',
				corePackage: 'SERIOUS',
				preset: 'full',
				projectName: 'notes-prod',
				exclusiveAppId: notesConfig.id,
			}),
			'prod',
		)
		const app = compileFabrikaManifest(notesConfig, 'prod')

		expect(namespace.topology.namespacePreset).toBe('full')
		expect(namespace.topology.exclusiveAppId).toBe(notesConfig.id)
		expect(namespace.steady.document.project?.name).toBe('notes-prod')
		expect(namespace.steady.document.services.map((service) => service.hostname)).toEqual([PROXY_HOSTNAME])
		expect(app.target.importDocument.services.map((service) => service['hostname'])).toEqual([NOTES_DATABASE_SERVICE, NOTES_SERVICE])
	})

	test('exclusive ownership is accepted only by the full preset', () => {
		expect(() => appsTopology({ env: 'prod', corePackage: 'SERIOUS', preset: 'full' })).toThrow('requires exclusiveAppId')
		expect(() => appsTopology({ env: 'prod', corePackage: 'SERIOUS', preset: 'mid', exclusiveAppId: notesConfig.id })).toThrow(
			'cannot reserve an exclusive app',
		)
	})
})

describe('the committed artifacts are what the declarations produce', () => {
	for (const artifact of generatedArtifacts()) {
		test(`${artifact.path} is up to date`, () => {
			expect(readFileSync(resolve(REPO_ROOT, artifact.path), 'utf8')).toBe(artifact.content)
		})
	}
})
