// Every live `zerops.yaml` in the repository, checked against Zerops' published JSON schema.
// The generated repository-root file owns fabrika's three setups; the example app owns its fixture.

import notesConfig from '@fabrika/example-zerops-app'
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generatedArtifacts, REPO_ROOT } from '../artifacts'
import { compileTopology, fabrikaTopologies } from '../topology'
import { parseYaml, validateYaml } from '../validate'

const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8')

const errorsIn = (path: string): string[] => validateYaml('zerops-yaml', read(path)).map((violation) => `${violation.path}: ${violation.message}`)

/** The `setup:` names a `zerops.yaml` declares, in order. */
const setupNames = (path: string): string[] => {
	const document = parseYaml(read(path))
	if (typeof document !== 'object' || document === null || !('zerops' in document) || !Array.isArray(document.zerops)) {
		throw new Error(`${path}: no \`zerops\` list`)
	}
	return document.zerops.flatMap((
		entry,
	) => (typeof entry === 'object' && entry !== null && 'setup' in entry && typeof entry.setup === 'string' ? [entry.setup] : []))
}

describe('the live files are valid against the published contract', () => {
	test('the repository-root zerops.yaml — zero errors', () => {
		expect(errorsIn('zerops.yaml')).toEqual([])
	})

	test("the example app's zerops.yaml — zero errors", () => {
		expect(errorsIn('examples/zerops-app/zerops.yaml')).toEqual([])
	})

	test("the example app's shared-Postgres variant — zero errors", () => {
		expect(errorsIn('examples/zerops-app/zerops.shared-postgres.yaml')).toEqual([])
	})
})

describe('one root file, several named setups — the merged-file decision, checked', () => {
	test('the root file declares exactly the four fabrika services that carry code', () => {
		expect(setupNames('zerops.yaml')).toEqual(['iam', 'operations', 'control', 'proxy'])
	})

	test('the root file emits only canonical fabrika environment names', () => {
		const yaml = read('zerops.yaml')
		expect(yaml).toContain('FABRIKA_IAM_RPC_URL:')
		expect(yaml).toContain('FABRIKA_OPERATIONS_URL:')
		expect(yaml).toContain('FABRIKA_CONTROL_ASSETS_DIR:')
		expect(yaml).not.toContain('PROPUSTKA_')
		expect(yaml).not.toContain('VOZKA_')
	})

	test('no DATA-service reference survives in the committed file — they name services a tier may not have', () => {
		// The rule this file states about itself: it carries only what is true for EVERY installation.
		// `${operationsdb_connectionString}` is not, because the light tier has no `operationsdb`, so every
		// data reference now travels through the env API instead. Verified live: an env-API variable
		// resolves `${x_y}` at container start exactly as one written here would have.
		const yaml = read('zerops.yaml')
		for (const reference of ['${db_', '${operationsdb_', '${storage_', '${operationsstorage_']) {
			expect(yaml).not.toContain(reference)
		}
		for (const name of ['FABRIKA_IAM_DATABASE_URL', 'FABRIKA_CONTROL_DATABASE_URL', 'FABRIKA_OPERATIONS_DATABASE_URL']) {
			expect(yaml).not.toContain(`${name}:`)
		}
	})

	test('ENVIRONMENT is per-installation too, not baked to `prod`', () => {
		expect(read('zerops.yaml')).not.toContain('ENVIRONMENT:')
	})

	test('the proxy publishes its listener pool, and the health port is not one of them', () => {
		// Routing is by host and two apps may not share one. On the `zerops-subdomain` path a hostname is
		// only obtainable per HTTP PORT, so the listener count IS the number of public hosts an
		// installation can serve: three for the platform's own, the rest a pool of application slots. The
		// health listener must stay off that list: published, it would answer 200 on a path that never
		// consults the gates.
		const document = parseYaml(read('zerops.yaml'))
		if (typeof document !== 'object' || document === null || !('zerops' in document) || !Array.isArray(document.zerops)) {
			throw new Error('zerops.yaml has no setups')
		}
		const proxy = document.zerops.find((entry) => typeof entry === 'object' && entry !== null && 'setup' in entry && entry.setup === 'proxy')
		expect(proxy).toMatchObject({
			run: {
				ports: [8080, 8082, 8083, 8084, 8085, 8086].map((port) => ({ port, httpSupport: true })),
				healthCheck: { httpGet: { port: 8081, path: '/healthz' } },
			},
		})
		// Caddy must actually bind what the service publishes, or a published port answers nothing.
		expect(read('zerops.yaml')).toContain('--listen :8080,:8082,:8083,:8084,:8085,:8086')
	})

	test('the proxy build lifts its manifest out of the runtime store — a build sees nothing else', () => {
		// Verified live: a build container reads its service env-API variables as the EMPTY STRING, with no
		// error. Without this bridge the manifest file would be empty, `generate-config.ts` would exit
		// non-zero, and the proxy would be undeployable on Zerops. `${RUNTIME_x}` is the only channel that
		// works, and it resolves nested references too.
		const document = parseYaml(read('zerops.yaml'))
		if (typeof document !== 'object' || document === null || !('zerops' in document) || !Array.isArray(document.zerops)) {
			throw new Error('zerops.yaml has no setups')
		}
		const proxy = document.zerops.find((entry) => typeof entry === 'object' && entry !== null && 'setup' in entry && entry.setup === 'proxy')
		expect(proxy).toMatchObject({
			build: { envVariables: { FABRIKA_PROXY_MANIFEST_JSON: '${RUNTIME_FABRIKA_PROXY_MANIFEST_JSON}' } },
		})
	})

	test('Operations maintenance runs every minute to preserve its one-minute spike threshold', () => {
		const document = parseYaml(read('zerops.yaml'))
		if (typeof document !== 'object' || document === null || !('zerops' in document) || !Array.isArray(document.zerops)) {
			throw new Error('zerops.yaml has no setups')
		}
		const operations = document.zerops.find(
			(entry) => typeof entry === 'object' && entry !== null && 'setup' in entry && entry.setup === 'operations',
		)
		expect(operations).toMatchObject({
			run: {
				crontab: [{ timing: '* * * * *', command: 'bun packages/operations/src/node/cron.ts', allContainers: false }],
			},
		})
	})

	test('every setup name is a service hostname in the platform import document', () => {
		const platform = compileTopology(
			fabrikaTopologies()[0] ?? (() => {
				throw new Error('no topology')
			})(),
			'prod',
		)
		const hostnames = new Set(platform.steady.document.services.map((service) => service.hostname))
		for (const setup of setupNames('zerops.yaml')) {
			expect(hostnames.has(setup)).toBe(true)
		}
	})

	test('and every code-carrying service names its setup, so a rename cannot silently pick another one', () => {
		const platform = compileTopology(
			fabrikaTopologies()[0] ?? (() => {
				throw new Error('no topology')
			})(),
			'prod',
		)
		const setups = new Set(setupNames('zerops.yaml'))
		for (const service of platform.steady.document.services) {
			if (service.zeropsSetup !== undefined) {
				expect(setups.has(service.zeropsSetup)).toBe(true)
				// Setup name == hostname is also Zerops' own default matching rule.
				expect(service.zeropsSetup).toBe(service.hostname)
			}
		}
	})

	test('NO import document inlines a `zeropsYaml` — the build spec lives in the repo, not in the import', () => {
		for (const artifact of generatedArtifacts()) {
			if (artifact.path.endsWith('.zerops-import.yaml')) {
				expect(artifact.content).not.toContain('zeropsYaml')
			}
		}
	})

	test("the example app's single setup matches the service its config deploys to", () => {
		expect(setupNames('examples/zerops-app/zerops.yaml')).toEqual([notesConfig.target.deployService ?? ''])
		expect(notesConfig.target.zeropsSetup).toBe(notesConfig.target.deployService)
	})
})

describe('nothing committed carries a secret VALUE', () => {
	// A reference is a pointer into the platform's own variable store; a value is a credential. Only the
	// first belongs in a committed file (ADR-0004). Scanned over the PARSED document rather than the raw
	// text, because comments never reach the platform and prose is allowed to talk about a reference.
	const REFERENCE = /^\$\{([a-z][a-z0-9]*_[A-Za-z][A-Za-z0-9]*|[A-Z][A-Z0-9_]*)\}$/
	const files = ['zerops.yaml', 'examples/zerops-app/zerops.yaml', 'examples/zerops-app/zerops.shared-postgres.yaml']

	const stringsIn = (value: unknown): string[] => {
		if (typeof value === 'string') {
			return [value]
		}
		if (Array.isArray(value)) {
			return value.flatMap(stringsIn)
		}
		if (typeof value === 'object' && value !== null) {
			return Object.entries(value).flatMap(([key, entry]) => [key, ...stringsIn(entry)])
		}
		return []
	}

	for (const file of files) {
		test(`${file}: every \${…} is a service-variable reference or an environment variable name`, () => {
			for (const text of stringsIn(parseYaml(read(file)))) {
				for (const match of text.matchAll(/\$\{[^}]*\}/g)) {
					expect(match[0]).toMatch(REFERENCE)
				}
			}
		})

		test(`${file}: no key material, no bearer token, no connection string with credentials in it`, () => {
			for (const text of stringsIn(parseYaml(read(file)))) {
				expect(text).not.toContain('-----BEGIN')
				expect(text).not.toMatch(/\bpx_[A-Za-z0-9]{8,}/)
				expect(text).not.toMatch(/\bpostgres(ql)?:\/\/[^$\s]*:[^$@\s]+@/)
			}
		})
	}
})

describe('the generated root file is the only fabrika platform build specification', () => {
	for (const path of ['packages/control/zerops.yaml', 'packages/iam/zerops.yaml', 'packages/operations/zerops.yaml', 'packages/proxy/zerops.yaml']) {
		test(`${path} stays deleted`, () => {
			expect(existsSync(resolve(REPO_ROOT, path))).toBe(false)
		})
	}
})
