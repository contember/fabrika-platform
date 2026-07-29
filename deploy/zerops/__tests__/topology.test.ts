// What the two generated topologies are asserted to be.
//
// Read the boundary carefully, because it is the whole value of this file: these tests prove the
// documents are WELL-FORMED against Zerops' published contract and that every invariant the ADRs
// require holds in them. They prove NOTHING about whether the platform accepts them, whether the
// services boot, or whether anything is reachable. Nobody has run this against a real account.

import { compileImport, type ZeropsImportDocument } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Artifact, generatedArtifacts, REPO_ROOT } from '../artifacts'
import { assertCorePackageIsExplicit, assertOnlyPublicService, assertZeropsHostnames } from '../invariants'
import { appsTopology, compileTopology, fabrikaTopologies, platformTopology, PROXY_HOSTNAME } from '../topology'
import { validateYaml } from '../validate'

const compiled = fabrikaTopologies().map((topology) => compileTopology(topology, 'prod'))

const documents = (): Array<{ label: string; document: ZeropsImportDocument }> =>
	compiled.flatMap((entry) => [
		{ label: `${entry.topology.id} (provision)`, document: entry.provision.document },
		{ label: `${entry.topology.id} (steady)`, document: entry.steady.document },
	])

const platform = compiled.find((entry) => entry.topology.id === 'platform')
const apps = compiled.find((entry) => entry.topology.id === 'apps-prod')

const importArtifacts = (): Artifact[] => generatedArtifacts().filter((artifact) => artifact.path.endsWith('.zerops-import.yaml'))

describe('every generated import document validates against the PUBLISHED JSON schema', () => {
	for (const artifact of importArtifacts()) {
		test(`${artifact.path} — zero errors`, () => {
			expect(validateYaml('import', artifact.content)).toEqual([])
		})
	}

	test('all four documents exist — provisioning and steady state, for both projects', () => {
		expect(importArtifacts().map((artifact) => artifact.path)).toEqual([
			'deploy/zerops/generated/platform.provision.zerops-import.yaml',
			'deploy/zerops/generated/platform.zerops-import.yaml',
			'deploy/zerops/generated/apps-prod.provision.zerops-import.yaml',
			'deploy/zerops/generated/apps-prod.zerops-import.yaml',
		])
	})
})

describe('the topology is the one ADR-0006 describes', () => {
	test('platform: the control plane, IAM, the proxy, Postgres and object storage — in one project of their own', () => {
		expect(platform?.steady.document.services.map((service) => service.hostname)).toEqual(['db', 'storage', 'iam', 'control', 'proxy'])
		expect(platform?.steady.document.project?.name).toBe('platform')
	})

	test('apps-prod is a SEPARATE project holding only the proxy — apps arrive as their own imports', () => {
		expect(apps?.steady.document.services.map((service) => service.hostname)).toEqual([PROXY_HOSTNAME])
		expect(apps?.steady.document.project?.name).toBe('apps-prod')
	})

	test('corePackage is stated explicitly on both — it cannot be downgraded, so a default is a decision nobody made', () => {
		expect(platform?.steady.document.project?.corePackage).toBe('SERIOUS')
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
	})

	test('the database and the object store are created FIRST (priority is descending)', () => {
		const byHostname = new Map(platform?.steady.document.services.map((service) => [service.hostname, service.priority ?? 0]))
		expect(byHostname.get('db')).toBe(100)
		expect(byHostname.get('storage')).toBe(100)
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
	for (const { label, document } of documents()) {
		test(`${label}: nothing enables subdomain access, and every runtime service says so explicitly`, () => {
			expect(document.services.filter((service) => service.enableSubdomainAccess === true)).toEqual([])
			// The runtime services state `false` rather than relying on the platform default, so enabling it
			// is a visible diff and the re-applied import corrects a GUI change.
			for (const hostname of ['iam', 'control', 'proxy']) {
				const service = document.services.find((entry) => entry.hostname === hostname)
				if (service !== undefined) {
					expect(service.enableSubdomainAccess).toBe(false)
				}
			}
		})
	}

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

describe('the committed artifacts are what the declarations produce', () => {
	for (const artifact of generatedArtifacts()) {
		test(`${artifact.path} is up to date`, () => {
			expect(readFileSync(resolve(REPO_ROOT, artifact.path), 'utf8')).toBe(artifact.content)
		})
	}
})
