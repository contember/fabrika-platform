// The witness for A7-1: a deploy-time variable value is DATA in the import document, never syntax.
// Every payload here is parsed back with a real YAML reader, because the claim is about what Zerops sees.

import type { JsonValue } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { renderYaml } from '../compile'
import { compileFabrikaManifest, createZeropsArtifactSourceDescriptor, type FabrikaImportDocument, manifestServiceHostnames } from '../manifest'
import { interpolateManifest } from '../provider'
import type { ZeropsAppConfig } from '../types'

const config: ZeropsAppConfig = {
	id: 'notes',
	pipeline: { secrets: ['TOKEN'], vars: ['IMAGE_TAG'] },
	target: {
		platform: 'zerops',
		deployService: 'notesapi',
		services: () => [
			{
				hostname: 'notesapi',
				type: 'alpine/bun@1.3',
				buildFromGit: 'https://github.com/acme/notes',
				zeropsSetup: process.env['IMAGE_TAG'],
			},
			{ hostname: 'notesdb', type: 'postgresql:single@18' },
		],
	},
}

const descriptor = await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: notesapi\n')
const manifest = compileFabrikaManifest(config, 'prod', descriptor)

const substitute = (
	values: Record<string, string>,
	document: FabrikaImportDocument = manifest.target.importDocument,
): FabrikaImportDocument => interpolateManifest(document, manifest.app.pipeline.vars, values, manifestServiceHostnames(manifest))

/** A hand-built document, so a placeholder can be put where the compiler would never plant one. */
const documentWith = (service: { readonly [key: string]: unknown }): FabrikaImportDocument => ({
	services: [{ hostname: 'notesapi', type: 'alpine/bun@1.3', envIsolation: 'service', override: true, ...service }],
})

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

// The reviewer's payload: it closes the quoted scalar, reopens the list and adds a service.
const HOSTILE = [
	'v1"',
	'    envIsolation: none',
	'  - hostname: evil',
	'    type: alpine@3.21',
	'    envIsolation: none',
	'    override: true',
	'    buildFromGit: https://github.com/attacker/pwn',
	'    zeropsSetup: "evil',
].join('\n')

describe('Zerops manifest variable substitution', () => {
	test('the compiler plants a placeholder the app cannot fill itself', () => {
		expect(manifest.target.importDocument.services[0]?.['zeropsSetup']).toBe('${IMAGE_TAG}')
	})

	test('a value that spells YAML structure stays one string', () => {
		const yaml = renderYaml(substitute({ IMAGE_TAG: HOSTILE }))
		const services = parsedServices(yaml)
		expect(services.map((service) => service['hostname'])).toEqual(['notesapi', 'notesdb'])
		expect(services.map((service) => service['envIsolation'])).toEqual(['service', 'service'])
		expect(services.map((service) => service['buildFromGit'])).toEqual(['https://github.com/acme/notes', undefined])
		expect(services[0]?.['zeropsSetup']).toBe(HOSTILE)
	})

	test('a multi-line value round-trips as the same string', () => {
		const value = 'first\nsecond: not-a-key\n  - not-an-item'
		const services = parsedServices(renderYaml(substitute({ IMAGE_TAG: value })))
		expect(services).toHaveLength(2)
		expect(services[0]?.['zeropsSetup']).toBe(value)
	})

	test('substitutes nested leaves, arrays included', () => {
		const document = documentWith({
			mount: ['${IMAGE_TAG}'],
			zeropsYaml: { run: { envVariables: { TAG: 'tag-${IMAGE_TAG}' } } },
		})
		const service = substitute({ IMAGE_TAG: 'v2' }, document).services[0]
		expect(service?.['mount']).toEqual(['v2'])
		expect(service?.['zeropsYaml']).toEqual({ run: { envVariables: { TAG: 'tag-v2' } } })
	})

	test('refuses a value naming a service the app does not own', () => {
		expect(() => substitute({ IMAGE_TAG: '${proxy_FABRIKA_IAM_KEY}' })).toThrow('references service `proxy`')
		expect(() => substitute({ IMAGE_TAG: '${proxy_FABRIKA_IAM_KEY}' }, documentWith({ zeropsYaml: { run: { envVariables: { K: '${IMAGE_TAG}' } } } })))
			.toThrow('references service `proxy`')
	})

	test("allows a value naming the app's own service or the shared database", () => {
		expect(substitute({ IMAGE_TAG: '${notesdb_connectionString}' }).services[0]?.['zeropsSetup']).toBe('${notesdb_connectionString}')
		expect(substitute({ IMAGE_TAG: '${postgres_dbName}' }).services[0]?.['zeropsSetup']).toBe('${postgres_dbName}')
	})

	test('refuses a reference two values spell together', () => {
		const document = documentWith({ zeropsSetup: '${IMAGE_TAG}${SUFFIX}', buildFromGit: 'https://github.com/acme/notes' })
		expect(() => interpolateManifest(document, ['IMAGE_TAG', 'SUFFIX'], { IMAGE_TAG: '${prox', SUFFIX: 'y_FABRIKA_IAM_KEY}' }, ['notesapi']))
			.toThrow('references service `proxy`')
	})

	test('resolves only declared variables, and only ones with a value', () => {
		expect(substitute({ IMAGE_TAG: 'v2' }).services[0]?.['zeropsSetup']).toBe('v2')
		expect(() => substitute({})).toThrow('no deploy-time value')
		expect(() => substitute({ OTHER: 'x' }, documentWith({ zeropsSetup: '${OTHER}', buildFromGit: 'https://github.com/acme/notes' }))).toThrow(
			'undeclared',
		)
	})

	test('every variable value survives the render byte for byte', () => {
		const values: Record<string, string> = {
			indentedFirstLine: '  v1\nsecond line',
			emptyFirstLine: '\nabc',
			blankFirstLine: '  \nabc',
			trailingNewline: 'a\nb\n',
			carriageReturn: 'a\r\nb',
			blankInteriorLine: 'a\n   \nb',
			singleLineHostile: 'v1" injected: yes',
			plainBlock: 'first\nsecond',
		}
		for (const value of Object.values(values)) {
			const services = parsedServices(renderYaml(substitute({ IMAGE_TAG: value })))
			expect(services.map((service) => service['hostname'])).toEqual(['notesapi', 'notesdb'])
			expect(services[0]?.['zeropsSetup']).toBe(value)
		}
	})

	test('refuses a placeholder standing in a service identity', () => {
		const document: FabrikaImportDocument = {
			services: [{ hostname: '${IMAGE_TAG}', type: 'alpine/bun@1.3', envIsolation: 'service', override: true }],
		}
		expect(() => substitute({ IMAGE_TAG: 'evil' }, document)).toThrow('changed service field `hostname`')
	})

	test('refuses a value that carries a placeholder of its own', () => {
		expect(() => substitute({ IMAGE_TAG: '${OTHER_VAR}' })).toThrow('survived substitution')
	})

	test('refuses a placeholder standing in any other service field', () => {
		expect(() =>
			substitute({ IMAGE_TAG: 'alpine/bun@1.3' }, {
				services: [{ hostname: 'notesapi', type: '${IMAGE_TAG}', envIsolation: 'service', override: true }],
			})
		).toThrow('changed service field `type`')
		expect(() =>
			substitute({ IMAGE_TAG: 'service' }, {
				services: [{ hostname: 'notesapi', type: 'alpine/bun@1.3', envIsolation: '${IMAGE_TAG}', override: true }],
			})
		).toThrow('changed service field `envIsolation`')
		expect(() =>
			substitute({ IMAGE_TAG: 'true' }, {
				services: [{ hostname: 'notesapi', type: 'alpine/bun@1.3', envIsolation: 'service', override: '${IMAGE_TAG}' }],
			})
		).toThrow('must carry `override: true`')
	})

	test('refuses a substitution inside the project entry', () => {
		const document: FabrikaImportDocument = {
			project: { name: '${IMAGE_TAG}', envIsolation: 'service' },
			services: [{ hostname: 'notesapi', type: 'alpine/bun@1.3', envIsolation: 'service', override: true }],
		}
		expect(() => substitute({ IMAGE_TAG: 'stolen' }, document)).toThrow('changed the project entry')
	})

	test('refuses a placeholder standing in a key', () => {
		const document = documentWith({ zeropsYaml: { run: { envVariables: { '${IMAGE_TAG}': 'v2' } } } })
		expect(() => substitute({ IMAGE_TAG: 'STOLEN' }, document)).toThrow('stands in an import document key')
	})

	test('a literal `__proto__` key stays data', () => {
		const polluting: JsonValue = JSON.parse('{"__proto__": {"polluted": "${IMAGE_TAG}"}}')
		const substituted = substitute({ IMAGE_TAG: 'v2' }, documentWith({ zeropsYaml: polluting }))
		const zeropsYaml = substituted.services[0]?.['zeropsYaml']
		expect(Object.getOwnPropertyNames(zeropsYaml ?? {})).toEqual(['__proto__'])
		expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined()
	})

	test('re-checks the ADR-0004 invariants on the substituted document', () => {
		const document: FabrikaImportDocument = {
			services: [{ hostname: 'notesapi', type: 'alpine/bun@1.3', envIsolation: 'none', override: true }],
		}
		expect(() => substitute({ IMAGE_TAG: 'v2' }, document)).toThrow('envIsolation must be `service`')
	})
})
