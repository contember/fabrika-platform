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
	test('the root file declares exactly the three fabrika services that carry code', () => {
		expect(setupNames('zerops.yaml')).toEqual(['iam', 'control', 'proxy'])
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
	for (const path of ['packages/control/zerops.yaml', 'packages/iam/zerops.yaml', 'packages/proxy/zerops.yaml']) {
		test(`${path} stays deleted`, () => {
			expect(existsSync(resolve(REPO_ROOT, path))).toBe(false)
		})
	}
})
