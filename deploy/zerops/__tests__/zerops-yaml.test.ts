// Every `zerops.yaml` in the repository, checked against Zerops' PUBLISHED `zerops.yaml` JSON schema.
//
// Two of them are the live ones — fabrika's generated repository-root file and the example app's
// hand-written one — and they must be clean. Two are the superseded per-package files, and their
// deviations are RECORDED rather than tolerated: the assertions below name the exact error each one
// produces, so fixing or deleting the file fails this test and forces the record to be updated.

import notesConfig from '@fabrika/example-zerops-app'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
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
	const files = ['zerops.yaml', 'examples/zerops-app/zerops.yaml']

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

describe('the superseded per-package files — deviations RECORDED, not tolerated', () => {
	// These two predate the merged root file and are no longer read by anything: Zerops loads
	// `zerops.yaml` from the repository ROOT. Their content lives on in `deploy/zerops/setups.ts`. Each
	// assertion below names the exact deviation, so deleting or fixing the file fails here on purpose.

	test('packages/iam/zerops.yaml: `protocol: TCP` is not a value the published schema accepts', () => {
		// The schema contradicts itself here — the enum is lowercase (`tcp`/`udp`) while the field's own
		// description, and every doc example, says `TCP`. The generated root file omits `protocol`
		// entirely rather than pick a side.
		expect(errorsIn('packages/iam/zerops.yaml')).toEqual(['zerops[0].run.ports[0].protocol: "TCP" is not one of the 2 allowed values'])
	})

	test('packages/proxy/zerops.yaml: `base: [go@1.23, bun@1.2]` names no build base the schema knows', () => {
		// Build bases are OS-qualified (`alpine/go@…`), and there is no `go@1.23` at any spelling — the
		// newest PINNED Go in the enum is 1.22. The generated root file uses `alpine/go@latest`, because
		// Caddy v2.10.2 needs a newer toolchain than the newest pin.
		expect(errorsIn('packages/proxy/zerops.yaml')).toEqual(['zerops[0].build.base: matched 0 of the `oneOf` branches, expected exactly 1'])
	})
})
