// The emitter's guarantee has to hold for the reader Zerops actually uses. go-yaml is a YAML 1.1 parser and
// 1.1 ends a line on U+0085/U+2028/U+2029 and refuses a raw C1 control; Bun's 1.2 reader does neither, so a
// test that only parses with Bun cannot see the difference. These assert on the rendered BYTES as well.

import { describe, expect, test } from 'bun:test'
import { renderYaml } from '../compile'
import { compileFabrikaManifest, createZeropsArtifactSourceDescriptor, type FabrikaImportDocument, manifestServiceHostnames } from '../manifest'
import { interpolateManifest } from '../provider'
import type { ZeropsAppConfig } from '../types'

/** Every code point a 1.1 reader breaks a line on or refuses, paired with the `\uXXXX` the emitter owes it. */
const HOSTILE: ReadonlyArray<readonly [string, string, string]> = [
	['U+0085 NEL', '\u0085', '\\u0085'],
	['U+2028 LS', '\u2028', '\\u2028'],
	['U+2029 PS', '\u2029', '\\u2029'],
	['U+0080 C1', '\u0080', '\\u0080'],
	['U+009F C1', '\u009f', '\\u009f'],
	['U+007F DEL', '\u007f', '\\u007f'],
]

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (value: unknown): { [key: string]: unknown } => {
	if (!isRecord(value)) throw new Error('expected a YAML mapping')
	return value
}

const parsedServices = (yaml: string): Array<{ [key: string]: unknown }> => {
	const services = record(Bun.YAML.parse(yaml))['services']
	if (!Array.isArray(services)) throw new Error('expected a YAML service list')
	return services.map(record)
}

const documentWith = (service: { readonly [key: string]: unknown }): { services: unknown[] } => ({
	services: [
		{ hostname: 'notesapi', type: 'alpine/bun@1.3', envIsolation: 'service', override: true, ...service },
		{ hostname: 'notesdb', type: 'postgresql:single@18', envIsolation: 'service', override: true },
	],
})

describe('the YAML emitter is exact for a YAML 1.1 reader too', () => {
	test('an ordinary multi-line value still goes out as a block', () => {
		const yaml = renderYaml(documentWith({ nginxConfig: 'server {\n  listen 80;\n}' }))
		expect(yaml).toContain('nginxConfig: |-')
	})

	for (const [name, character, escaped] of HOSTILE) {
		test(`${name} in an otherwise block-eligible value is escaped, not blocked`, () => {
			const value = `server {\n  listen 80${character}  - hostname: evil;\n}`
			const yaml = renderYaml(documentWith({ nginxConfig: value }))
			expect(yaml.includes(character)).toBe(false)
			expect(yaml).toContain(escaped)
			const services = parsedServices(yaml)
			expect(services.map((service) => service['hostname'])).toEqual(['notesapi', 'notesdb'])
			expect(services[0]?.['nginxConfig']).toBe(value)
		})

		test(`${name} in a single-line value is escaped`, () => {
			const value = `v1${character}  - hostname: evil`
			const yaml = renderYaml(documentWith({ zeropsSetup: value }))
			expect(yaml.includes(character)).toBe(false)
			expect(yaml).toContain(escaped)
			const services = parsedServices(yaml)
			expect(services.map((service) => service['hostname'])).toEqual(['notesapi', 'notesdb'])
			expect(services[0]?.['zeropsSetup']).toBe(value)
		})

		test(`${name} in a key is escaped`, () => {
			const key = `TAG${character}  - hostname: evil`
			const yaml = renderYaml(documentWith({ zeropsYaml: { run: { envVariables: { [key]: 'v2' } } } }))
			expect(yaml.includes(character)).toBe(false)
			expect(yaml).toContain(escaped)
			const services = parsedServices(yaml)
			expect(services.map((service) => service['hostname'])).toEqual(['notesapi', 'notesdb'])
			expect(Object.keys(record(record(record(services[0]?.['zeropsYaml'])['run'])['envVariables']))).toEqual([key])
		})
	}
})

// A one-line variable value carrying an LS, substituted into a multi-line leaf. It passes for one line in
// JavaScript and reads as two to go-yaml, so before the fix the remainder became a second service entry.
describe('a variable value cannot grow the document a service', () => {
	const config: ZeropsAppConfig = {
		id: 'notes',
		pipeline: { vars: ['PORT'] },
		target: {
			platform: 'zerops',
			deployService: 'notesapi',
			services: () => [
				{
					hostname: 'notesapi',
					type: 'alpine/bun@1.3',
					buildFromGit: 'https://github.com/acme/notes',
					nginxConfig: `server {\n  listen ${process.env['PORT']};\n}`,
				},
				{ hostname: 'notesdb', type: 'postgresql:single@18' },
			],
		},
	}

	test('a separator inside a block-scalar leaf stays inside the value', async () => {
		const descriptor = await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: notesapi\n')
		const manifest = compileFabrikaManifest(config, 'prod', descriptor)
		const value = [
			'80',
			'  - hostname: evil',
			'    type: alpine@3.21',
			'    envIsolation: none',
			'    override: true',
			'    buildFromGit: https://github.com/attacker/pwn',
		].join('\u2028')
		const document: FabrikaImportDocument = interpolateManifest(
			manifest.target.importDocument,
			manifest.app.pipeline.vars,
			{ PORT: value },
			manifestServiceHostnames(manifest),
		)
		const yaml = renderYaml(document)
		expect(yaml.includes('\u2028')).toBe(false)
		const services = parsedServices(yaml)
		expect(services.map((service) => service['hostname'])).toEqual(['notesapi', 'notesdb'])
		expect(services.map((service) => service['envIsolation'])).toEqual(['service', 'service'])
		expect(services[0]?.['nginxConfig']).toBe(`server {\n  listen ${value};\n}`)
	})
})
