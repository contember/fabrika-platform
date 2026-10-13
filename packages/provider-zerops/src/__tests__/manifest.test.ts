import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { prepareZeropsDescriptor } from '../descriptor'
import { zeropsContractRun } from '../execution'
import { assertAuthoredManagedDocument, overlayRelease } from '../managed-env'
import {
	assertFabrikaManifestCoordinates,
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	FABRIKA_MANIFEST_VERSION,
	type FabrikaImportDocument,
	type FabrikaManifest,
	hashFabrikaManifest,
	manifestServiceHostnames,
	parseFabrikaManifest,
	renderFabrikaImportYaml,
	renderFabrikaProvisioningYaml,
	verifyZeropsArtifactSourceDescriptor,
	ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES,
	zeropsArtifactCodec,
} from '../manifest'
import { interpolateManifest } from '../provider'
import type { ZeropsAppConfig, ZeropsServiceSpec } from '../types'

const config: ZeropsAppConfig = {
	id: 'notes',
	schema: {
		scopes: [{ type: 'workspace', label: 'Workspace' }],
		actions: [{ action: 'notes.read' }],
		roles: { reader: { name: 'Reader', permissions: ['notes.read'] } },
	},
	pipeline: { secrets: ['TOKEN'], vars: ['IMAGE_TAG'] },
	target: {
		platform: 'zerops',
		services: ({ env }) => [
			{ hostname: env === 'prod' ? 'notes' : 'notesstage', type: 'alpine/bun@1.3', nginxConfig: process.env['IMAGE_TAG'] },
		],
	},
}

describe('Zerops static artifact', () => {
	test('retains the original descriptor and artifact hashes without materializing an implicit selector or optional fields', async () => {
		const contents = '# original\r\nzerops: [{setup: notes}]\r\n'
		const descriptor = await createZeropsArtifactSourceDescriptor(contents)
		const manifest = compileFabrikaManifest(
			{ id: 'notes', target: { platform: 'zerops', services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }] } },
			'prod',
			descriptor,
		)
		const decoded = zeropsArtifactCodec.decode(zeropsArtifactCodec.encode(manifest))
		expect(decoded).toEqual(manifest)
		expect(decoded.target.sourceDescriptor.contents).toBe(contents)
		expect(decoded.target.sourceDescriptor.sha256).toBe('e68d0432c77f44ce072ee36fdbef256816d8e589021ca0e84fc21961c94bdc59')
		expect(await hashFabrikaManifest(decoded)).toBe('6d4914f2c99e3c353f930a8e44fa4b831f6fac03002a8c5e6da59e34902e2e1e')
		expect(Object.keys(decoded.app)).toEqual(['id', 'env', 'pipeline'])
		expect(Object.keys(decoded.target)).toEqual(['platform', 'sourceDescriptor', 'importDocument', 'deployService'])
		expect(Object.keys(decoded.target.importDocument)).toEqual(['services'])
	})

	test('checks decoded coordinates with exact drift errors and keeps parser validation order', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		const decoded = zeropsArtifactCodec.decode(zeropsArtifactCodec.encode(manifest))
		expect(() => assertFabrikaManifestCoordinates(decoded.app, {})).not.toThrow()
		expect(() => assertFabrikaManifestCoordinates(decoded.app, { appId: 'notes', env: 'prod' })).not.toThrow()
		for (const expected of [{ appId: 'other', env: 'stage' }, { env: 'stage' }]) {
			const error = expected.appId === undefined
				? 'manifest environment drift: expected `stage`, got `prod`'
				: 'manifest app drift: expected `other`, got `notes`'
			expect(() => assertFabrikaManifestCoordinates(decoded.app, expected)).toThrow(error)
			expect(() => parseFabrikaManifest({ ...manifest, target: {} }, expected)).toThrow(error)
		}
	})

	test('renders first registration as collision-refusing and codeless for every service without mutating the artifact', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		const original = structuredClone(manifest)
		const yaml = renderFabrikaProvisioningYaml(manifest)
		expect(yaml.match(/override: false/g)).toHaveLength(2)
		expect(yaml.match(/startWithoutCode: true/g)).toHaveLength(2)
		expect(yaml).not.toContain('override: true')
		expect(manifest).toEqual(original)
		expect(renderFabrikaImportYaml(manifest).match(/override: true/g)).toHaveLength(2)
		expect(renderFabrikaImportYaml(manifest)).not.toContain('startWithoutCode')
		expect(parseFabrikaManifest(zeropsArtifactCodec.encode(manifest))).toEqual(original)
	})

	test('compiles environment-specific services, source descriptor, and declared vars as placeholders', async () => {
		process.env['IMAGE_TAG'] = 'must-not-leak'
		const sourceDescriptor = await createZeropsArtifactSourceDescriptor('zerops:\r\n  - setup: notes\r\n')
		const manifest = compileFabrikaManifest(config, 'prod', sourceDescriptor)
		expect(manifestServiceHostnames(manifest)).toEqual(['notes'])
		expect(manifest.manifestVersion).toBe(3)
		expect(zeropsArtifactCodec.version).toBe(3)
		expect(FABRIKA_MANIFEST_VERSION).toBe(3)
		expect(manifest.target.sourceDescriptor).toEqual(sourceDescriptor)
		expect(sourceDescriptor.contents).toContain('\r\n')
		expect(sourceDescriptor.sha256).toBe('d1d6553b6db05b027ecacc35e1048e1846005d5d595268f32c6bf89aeec0019c')
		expect(sourceDescriptor.sha256).not.toBe((await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: notes\n')).sha256)
		expect(renderFabrikaImportYaml(manifest)).toContain('${IMAGE_TAG}')
		expect(renderFabrikaImportYaml(manifest)).not.toContain('must-not-leak')
		expect(process.env['IMAGE_TAG']).toBe('must-not-leak')
		expect(parseFabrikaManifest(zeropsArtifactCodec.encode(manifest))).toEqual(manifest)
	})

	test('rejects version, identity, environment, descriptor, proxy ownership, and forbidden structured import drift', async () => {
		const descriptor = await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: notes\n')
		const manifest = compileFabrikaManifest(config, 'prod', descriptor)
		const service = manifest.target.importDocument.services[0]
		if (service === undefined) throw new Error('expected a service')
		expect(() => parseFabrikaManifest({ ...manifest, manifestVersion: 1 })).toThrow('version')
		expect(() => parseFabrikaManifest({ ...manifest, manifestVersion: 2 })).toThrow('version')
		expect(() => parseFabrikaManifest(manifest, { appId: 'other' })).toThrow('app drift')
		expect(() => parseFabrikaManifest(manifest, { env: 'stage' })).toThrow('environment drift')
		expect(() => parseFabrikaManifest({ ...manifest, target: { ...manifest.target, sourceDescriptor: undefined } })).toThrow('source descriptor')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, sourceDescriptor: { ...descriptor, path: 'nested/zerops.yaml' } },
			})
		).toThrow('source descriptor')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, sourceDescriptor: { ...descriptor, contents: '' } },
			})
		).toThrow('source descriptor')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, sourceDescriptor: { ...descriptor, contents: 'x'.repeat(ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES + 1) } },
			})
		).toThrow('source descriptor')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, sourceDescriptor: { ...descriptor, sha256: descriptor.sha256.toUpperCase() } },
			})
		).toThrow('source descriptor')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, sourceDescriptor: { ...descriptor, sha256: '0'.repeat(63) } },
			})
		).toThrow('source descriptor')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, sourceDescriptor: { ...descriptor, extra: true } },
			})
		).toThrow('source descriptor field')
		const table = contractProxyTable(notesArtifact)
		expect(() => parseFabrikaManifest({ ...manifest, target: { ...manifest.target, proxy: { upstream: '', ...table } } })).toThrow('proxy')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, contract: zeropsContractRun(notesArtifact), proxy: { upstream: 'other:3000', ...table } },
			})
		).toThrow('not owned')
		// An application is protected by its contract's endpoint table; gates are refused, never ignored.
		expect(() => parseFabrikaManifest({ ...manifest, target: { ...manifest.target, proxy: { upstream: 'notes:3000', gates: { rules: [] } } } }))
			.toThrow('invalid fabrika manifest proxy: `gates` is gone')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, contract: zeropsContractRun(notesArtifact), proxy: { upstream: 'notes:3000', ...table, gates: { rules: [] } } },
			})
		).toThrow('invalid fabrika manifest proxy: `gates` is gone')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: {
					...manifest.target,
					importDocument: { services: [{ ...service, envSecrets: { X: 'value' } }] },
				},
			})
		).toThrow('forbidden')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, importDocument: undefined, importYaml: 'services: []', serviceHostnames: ['notes'] },
			})
		).toThrow('import')
	})

	test('applies the source descriptor limit to exact UTF-8 bytes', async () => {
		const prefix = 'zerops: [{setup: notes}]\n# '
		const padding = ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES - new TextEncoder().encode(prefix).byteLength
		const exact = await createZeropsArtifactSourceDescriptor(prefix + 'é'.repeat(Math.floor(padding / 2)) + 'x'.repeat(padding % 2))
		expect(new TextEncoder().encode(exact.contents).byteLength).toBe(ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES)
		expect(parseFabrikaManifest(compileFabrikaManifest(config, 'prod', exact)).target.sourceDescriptor).toEqual(exact)
		await expect(createZeropsArtifactSourceDescriptor(`${exact.contents}é`)).rejects.toThrow('exceeds')
	})

	test('verifies exact descriptor contents against the original digest', async () => {
		const descriptor = await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: notes\n')
		await expect(verifyZeropsArtifactSourceDescriptor(descriptor)).resolves.toBeUndefined()
		await expect(verifyZeropsArtifactSourceDescriptor({ ...descriptor, contents: `${descriptor.contents}# tampered\n` })).rejects.toThrow(
			'digest mismatch',
		)
	})
	test('preserves original escaped noncharacters and their source digest', async () => {
		for (const code of ['fffe', 'ffff']) {
			const contents = `# original\r\nzerops: [{setup: notes, x: "a\\u${code}b"}]\r\n`
			const descriptor = await createZeropsArtifactSourceDescriptor(contents)
			const manifest = compileFabrikaManifest(config, 'prod', descriptor)
			expect(manifest.target.sourceDescriptor).toEqual(descriptor)
			expect(manifest.target.sourceDescriptor.contents).toBe(contents)
			await expect(verifyZeropsArtifactSourceDescriptor(manifest.target.sourceDescriptor)).resolves.toBeUndefined()
		}
	})

	test('interpolates only declared variables', () => {
		const document = (buildFromGit: string): FabrikaImportDocument => ({
			services: [{ hostname: 'notes', type: 'alpine/bun@1.3', envIsolation: 'service', override: true, buildFromGit }],
		})
		expect(interpolateManifest(document('${IMAGE_TAG}'), ['IMAGE_TAG'], { IMAGE_TAG: 'v2' }, ['notes'])).toEqual(document('v2'))
		expect(() => interpolateManifest(document('${IMAGE_TAG}'), ['IMAGE_TAG'], {}, ['notes'])).toThrow('no deploy-time value')
		expect(() => interpolateManifest(document('${OTHER}'), ['IMAGE_TAG'], { OTHER: 'x' }, ['notes'])).toThrow('undeclared')
	})
})

const notesConfig: ZeropsAppConfig = {
	id: 'notes',
	pipeline: { secrets: [], vars: [] },
	target: {
		platform: 'zerops',
		services: () => [{ hostname: 'notesdb', type: 'postgresql:single@18' }, { hostname: 'notesapi', type: 'alpine/bun@1.3' }],
		deployService: 'notesapi',
	},
}

const sharedPostgresConfig: ZeropsAppConfig = {
	...notesConfig,
	target: { ...notesConfig.target, services: () => [{ hostname: 'notesapi', type: 'alpine/bun@1.3' }] },
}

const OWN_SETUP = 'zerops:\n  - setup: notesapi\n'

const compileNotes = async (contents: string, config: ZeropsAppConfig = notesConfig): Promise<FabrikaManifest> =>
	compileFabrikaManifest(config, 'prod', await createZeropsArtifactSourceDescriptor(contents))

const withServiceField = (manifest: FabrikaManifest, field: string, value: unknown): unknown => ({
	...manifest,
	target: {
		...manifest.target,
		importDocument: {
			services: manifest.target.importDocument.services.map((service) => service['hostname'] === 'notesapi' ? { ...service, [field]: value } : service),
		},
	},
})

/** A field this manifest does not model: its references are walked like any other. */
const withUnmodelledField = (manifest: FabrikaManifest, value: unknown): unknown => withServiceField(manifest, 'futureField', value)

const isYamlMapping = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value)

const parsedImportServices = (yaml: string): Array<{ [key: string]: unknown }> => {
	const document: unknown = Bun.YAML.parse(yaml)
	const services = isYamlMapping(document) ? document['services'] : undefined
	if (!Array.isArray(services)) throw new Error('expected a YAML service list')
	return services.filter(isYamlMapping)
}

const exampleDescriptor = async (file: string): Promise<string> =>
	await Bun.file(new URL(`../../../../examples/zerops-app/${file}`, import.meta.url)).text()

describe('managed key manifest boundary', () => {
	test('pure authored walk accepts frozen readonly structures without changing them', () => {
		const services = Object.freeze([
			Object.freeze({ hostname: 'notesapi', envVariables: Object.freeze({ APP_READ: '${notesdb_connectionString}' }) }),
		])
		expect(() => assertAuthoredManagedDocument(services)).not.toThrow()
		expect(services[0]?.envVariables.APP_READ).toBe('${notesdb_connectionString}')
	})

	test('refuses a variable that copies a framework-only variable, in every reference form (ADR-0022 rule 5)', async () => {
		for (
			const reference of [
				'${FABRIKA_PROXY_SECRET}',
				'${RUNTIME_FABRIKA_PROXY_SECRET}',
				'${notesapi_FABRIKA_PROXY_SECRET}',
				'${RUNTIME_notesapi_FABRIKA_APP_DATABASE_URL}',
				'${FABRIKA_PROXY_${SUFFIX}}',
			]
		) {
			for (const phase of ['build', 'run']) {
				// The reviewer's case: `COPY` holds the secret, and anything that prints `$COPY` prints it.
				const descriptor = await createZeropsArtifactSourceDescriptor(
					`zerops:\n  - setup: notesapi\n    ${phase}:\n      envVariables:\n        COPY: "${reference}"\n`,
				)
				expect(() => compileFabrikaManifest({ ...notesConfig, target: { ...notesConfig.target, zeropsSetup: 'notesapi' } }, 'prod', descriptor))
					.toThrow('references the Fabrika-managed variable')
			}
			expect(() => assertAuthoredManagedDocument([{ hostname: 'notesapi', envVariables: { COPY: reference } }])).toThrow(
				'references the Fabrika-managed variable',
			)
		}
	})

	test('rejects internal and canonical managed definitions in pipeline declarations and import mappings', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		for (const name of ['FABRIKA_RELEASE', 'FABRIKA_OPERATIONS_DSN', 'FABRIKA_SERVICE_KEY']) {
			for (const kind of ['vars', 'secrets']) {
				expect(() =>
					parseFabrikaManifest({
						...manifest,
						app: { ...manifest.app, pipeline: { ...manifest.app.pipeline, [kind]: [name] } },
					})
				).toThrow('Fabrika-managed')
			}
			expect(() =>
				parseFabrikaManifest({
					...manifest,
					target: {
						...manifest.target,
						importDocument: {
							services: manifest.target.importDocument.services.map((service) => ({ ...service, envVariables: { [name]: 'authored' } })),
						},
					},
				})
			).toThrow('Fabrika-managed')
		}
	})

	test('refuses an application that sets or copies a storage variable itself: only the platform names its bucket', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		const names = [
			'FABRIKA_APP_STORAGE_ENDPOINT',
			'FABRIKA_APP_STORAGE_BUCKET',
			'FABRIKA_APP_STORAGE_ACCESS_KEY_ID',
			'FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY',
		]
		for (const name of names) {
			for (const kind of ['vars', 'secrets']) {
				expect(() => parseFabrikaManifest({ ...manifest, app: { ...manifest.app, pipeline: { ...manifest.app.pipeline, [kind]: [name] } } }))
					.toThrow('Fabrika-managed')
			}
			for (const envVariables of [{ [name]: '${otherfiles_secretAccessKey}' }, { COPY: `\${${name}}` }]) {
				expect(() => assertAuthoredManagedDocument([{ hostname: 'notesapi', envVariables }])).toThrow('Fabrika-managed')
			}
			for (const phase of ['build', 'run']) {
				const descriptor = await createZeropsArtifactSourceDescriptor(
					`zerops:\n  - setup: notesapi\n    ${phase}:\n      envVariables:\n        ${name}: authored\n`,
				)
				expect(() => compileFabrikaManifest({ ...notesConfig, target: { ...notesConfig.target, zeropsSetup: 'notesapi' } }, 'prod', descriptor))
					.toThrow('Fabrika-managed')
			}
		}
	})

	test('refuses an application that sets or copies its IAM membership transport: only the platform writes its key', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		for (const name of ['FABRIKA_IAM_RPC_URL', 'FABRIKA_IAM_RPC_KEY']) {
			for (const kind of ['vars', 'secrets']) {
				expect(() => parseFabrikaManifest({ ...manifest, app: { ...manifest.app, pipeline: { ...manifest.app.pipeline, [kind]: [name] } } }))
					.toThrow('Fabrika-managed')
			}
			for (const envVariables of [{ [name]: 'authored' }, { COPY: `\${RUNTIME_${name}}` }]) {
				expect(() => assertAuthoredManagedDocument([{ hostname: 'notesapi', envVariables }])).toThrow('Fabrika-managed')
			}
			for (const phase of ['build', 'run']) {
				const descriptor = await createZeropsArtifactSourceDescriptor(
					`zerops:\n  - setup: notesapi\n    ${phase}:\n      envVariables:\n        ${name}: authored\n`,
				)
				expect(() => compileFabrikaManifest({ ...notesConfig, target: { ...notesConfig.target, zeropsSetup: 'notesapi' } }, 'prod', descriptor))
					.toThrow('Fabrika-managed')
			}
		}
	})

	test('checks decoded descriptor policy in selected and unselected setups, including build/run mappings', async () => {
		for (const phase of ['build', 'run']) {
			for (const env of ['FABRIKA_RELEASE: authored', 'FABRIKA_APP_ID: authored']) {
				const descriptor = await createZeropsArtifactSourceDescriptor(
					`zerops:\n  - setup: notesapi\n  - setup: other\n    ${phase}:\n      envVariables:\n        ${env}\n`,
				)
				expect(() => compileFabrikaManifest({ ...notesConfig, target: { ...notesConfig.target, zeropsSetup: 'notesapi' } }, 'prod', descriptor))
					.toThrow('Fabrika-managed')
			}
		}
		const valid = await compileNotes('zerops:\n  - setup: notesapi\n    run:\n      start: echo ${FABRIKA_RELEASE}\n')
		expect(parseFabrikaManifest(valid).target.sourceDescriptor).toEqual(valid.target.sourceDescriptor)
	})

	test('artifact digest ignores object insertion order but retains array order and original descriptor bytes', async () => {
		const manifest = await compileNotes(`${OWN_SETUP}# original\r\n`)
		const original = structuredClone(manifest)
		const digest = await hashFabrikaManifest(manifest)
		expect(digest).toMatch(/^[a-f0-9]{64}$/)
		const reordered = parseFabrikaManifest({
			target: {
				...manifest.target,
				importDocument: {
					services: manifest.target.importDocument.services.map((service) => Object.fromEntries(Object.entries(service).reverse())),
				},
			},
			app: manifest.app,
			manifestVersion: manifest.manifestVersion,
		})
		expect(await hashFabrikaManifest(reordered)).toBe(digest)
		const reversed = parseFabrikaManifest({
			...manifest,
			target: {
				...manifest.target,
				importDocument: { services: [...manifest.target.importDocument.services].reverse() },
			},
		})
		expect(await hashFabrikaManifest(reversed)).not.toBe(digest)
		const normalizedNewlines = await compileNotes(`${OWN_SETUP}# original\n`)
		expect(await hashFabrikaManifest(normalizedNewlines)).not.toBe(digest)
		expect(normalizedNewlines.target.sourceDescriptor.sha256).not.toBe(manifest.target.sourceDescriptor.sha256)
		expect(manifest).toEqual(original)
	})

	test('interpolation and reference overlay leave the original artifact and descriptor identities intact', async () => {
		const descriptor = await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: notes\n    run:\n      start: bun app.ts\n')
		const manifest = compileFabrikaManifest(config, 'prod', descriptor)
		const original = structuredClone(manifest)
		const digest = await hashFabrikaManifest(manifest)
		const document = interpolateManifest(manifest.target.importDocument, ['IMAGE_TAG'], { IMAGE_TAG: 'https://example.test/repo' }, ['notes'])
		expect(document).not.toEqual(manifest.target.importDocument)
		const execution = overlayRelease(descriptor.contents, undefined, 'fabrika/notes/prod/default/abc')
		expect(Bun.YAML.parse(execution.contents)).toEqual({
			zerops: [{ setup: 'notes', run: { start: 'bun app.ts', envVariables: { FABRIKA_RELEASE: 'fabrika/notes/prod/default/abc' } } }],
		})
		expect(descriptor.contents).not.toContain('FABRIKA_RELEASE')
		expect(await hashFabrikaManifest(manifest)).toBe(digest)
		await expect(verifyZeropsArtifactSourceDescriptor(manifest.target.sourceDescriptor)).resolves.toBeUndefined()
		expect(manifest).toEqual(original)
	})
})

describe('application exposure refusals', () => {
	const withApiFields = (fields: Partial<ZeropsServiceSpec>): ZeropsAppConfig => ({
		...notesConfig,
		target: {
			...notesConfig.target,
			services: () => [{ hostname: 'notesdb', type: 'postgresql:single@18' }, { hostname: 'notesapi', type: 'alpine/bun@1.3', ...fields }],
		},
	})

	const refused: ReadonlyArray<readonly [keyof ZeropsServiceSpec, Partial<ZeropsServiceSpec>, string]> = [
		['objectStoragePolicy', { objectStoragePolicy: 'public-read' }, 'omit it or set `private`'],
		['objectStoragePolicy', { objectStoragePolicy: 'custom' }, 'omit it or set `private`'],
		['objectStorageRawPolicy', { objectStorageRawPolicy: '{"Statement":[]}' }, 'omit it'],
		['enableSubdomainAccess', { enableSubdomainAccess: true }, 'omit it or set `false`'],
		['buildFromGit', { buildFromGit: 'https://github.com/acme/notes' }, 'omit it'],
		['zeropsYaml', { zeropsYaml: { zerops: [{ setup: 'notesapi' }] } }, 'omit it'],
		['mount', { mount: ['shared'] }, 'omit it'],
		['enableCdn', { enableCdn: true }, 'omit it or set `false`'],
		['startWithoutCode', { startWithoutCode: true }, 'omit it; the platform provisions a new service without code itself'],
		['startWithoutCode', { startWithoutCode: false }, 'omit it; the platform provisions a new service without code itself'],
	]

	test('refuses each exposing field on an application service at compile time, naming the allowed form', async () => {
		const descriptor = await createZeropsArtifactSourceDescriptor(OWN_SETUP)
		for (const [field, fields, allowedForm] of refused) {
			const compile = () => compileFabrikaManifest(withApiFields(fields), 'prod', descriptor)
			expect(compile).toThrow(`Zerops service \`notesapi\` sets \`${field}\`;`)
			expect(compile).toThrow(`(${allowedForm})`)
		}
	})

	test('refuses each exposing field in a stored artifact at the decode boundary', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		for (const [field, fields] of refused) {
			const value = fields[field]
			expect(() => parseFabrikaManifest(withServiceField(manifest, field, value))).toThrow(`Zerops service \`notesapi\` sets \`${field}\`;`)
		}
	})

	test('writes an explicit private policy on an object-storage service that omits one', async () => {
		const storage: ZeropsServiceSpec = { hostname: 'notesfiles', type: 'object-storage', objectStorageSize: 1 }
		const config: ZeropsAppConfig = {
			...notesConfig,
			target: { ...notesConfig.target, services: () => [...notesConfig.target.services({ env: 'prod' }), storage] },
		}
		const manifest = await compileNotes(OWN_SETUP, config)
		const compiled = manifest.target.importDocument.services.find((service) => service.hostname === 'notesfiles')
		expect(compiled).toMatchObject({ type: 'object-storage', objectStoragePolicy: 'private' })
		const runtime = manifest.target.importDocument.services.find((service) => service.hostname === 'notesapi')
		expect(runtime?.['objectStoragePolicy']).toBeUndefined()

		const rendered = parsedImportServices(renderFabrikaImportYaml(manifest)).find((service) => service['hostname'] === 'notesfiles')
		expect(rendered?.['objectStoragePolicy']).toBe('private')
		const provisioning = parsedImportServices(renderFabrikaProvisioningYaml(manifest)).find((service) => service['hostname'] === 'notesfiles')
		expect(provisioning?.['objectStoragePolicy']).toBe('private')

		const withoutPolicy = manifest.target.importDocument.services.map((service) =>
			Object.fromEntries(Object.entries(service).filter(([key]) => key !== 'objectStoragePolicy'))
		)
		const stored = parseFabrikaManifest({ ...manifest, target: { ...manifest.target, importDocument: { services: withoutPolicy } } })
		expect(stored.target.importDocument.services.find((service) => service.hostname === 'notesfiles')?.['objectStoragePolicy']).toBe('private')

		const refused: ZeropsServiceSpec = { ...storage, objectStoragePolicy: 'public-read' }
		const publicBucket: ZeropsAppConfig = {
			...notesConfig,
			target: { ...notesConfig.target, services: () => [...notesConfig.target.services({ env: 'prod' }), refused] },
		}
		await expect(compileNotes(OWN_SETUP, publicBucket)).rejects.toThrow('Zerops service `notesfiles` sets `objectStoragePolicy`;')
	})

	test('accepts the forms that expose nothing', async () => {
		const manifest = compileFabrikaManifest(
			withApiFields({ enableSubdomainAccess: false, enableCdn: false, objectStoragePolicy: 'private' }),
			'prod',
			await createZeropsArtifactSourceDescriptor(OWN_SETUP),
		)
		expect(manifest.target.importDocument.services[1]).toMatchObject({ enableSubdomainAccess: false, enableCdn: false, objectStoragePolicy: 'private' })
	})
})

describe('release overlay', () => {
	const TWO_SETUPS =
		'zerops:\n  - setup: api\n    run:\n      envVariables:\n        OWN: kept\n  - setup: worker\n    run:\n      start: bun worker.ts\n'

	test('writes FABRIKA_RELEASE as a literal into the selected setup, the only one executed', () => {
		const execution = overlayRelease(TWO_SETUPS, 'worker', 'release-1')
		expect(execution.setup).toBe('worker')
		expect(Bun.YAML.parse(execution.contents)).toEqual({
			zerops: [{ setup: 'worker', run: { start: 'bun worker.ts', envVariables: { FABRIKA_RELEASE: 'release-1' } } }],
		})
	})

	test('omits the key when the release is null', () => {
		const execution = overlayRelease(TWO_SETUPS, 'api', null)
		expect(execution.contents).not.toContain('FABRIKA_RELEASE')
		expect(Bun.YAML.parse(execution.contents)).toEqual({ zerops: [{ setup: 'api', run: { envVariables: { OWN: 'kept' } } }] })
	})

	test('keeps an extended parent and refuses to replace the run section a setup inherits', () => {
		const extending =
			'zerops:\n  - setup: base\n    run:\n      start: bun server.ts\n  - setup: shared\n    extends: base\n    run:\n      start: bun shared.ts\n'
		expect(Bun.YAML.parse(overlayRelease(extending, 'shared', 'release-1').contents)).toEqual({
			zerops: [
				{ setup: 'shared', extends: 'base', run: { start: 'bun shared.ts', envVariables: { FABRIKA_RELEASE: 'release-1' } } },
				{ setup: 'base', run: { start: 'bun server.ts' } },
			],
		})
		const inheriting = 'zerops:\n  - setup: base\n    run:\n      start: bun server.ts\n  - setup: shared\n    extends: base\n'
		expect(() => overlayRelease(inheriting, 'shared', 'release-1')).toThrow('must declare its own run section')
	})

	test('refuses a release that Zerops would read as a reference', () => {
		expect(() => overlayRelease(TWO_SETUPS, 'api', 'release-${api_PASSWORD}')).toThrow('must not contain `${`')
	})

	test('refuses a descriptor that authors a managed key', () => {
		expect(() => overlayRelease('zerops:\n  - setup: api\n    run:\n      envVariables:\n        FABRIKA_RELEASE: mine\n', 'api', 'release-1'))
			.toThrow('Fabrika-managed')
	})
})

describe('cross-service variable references', () => {
	test('checks decoded keys and unknown leaves in the selected setup and every setup it extends', async () => {
		for (const extra of ['{"\\x24{proxy_FABRIKA_IAM_KEY}": safe}', '{future: ["\\x24{proxy_FABRIKA_IAM_KEY}"]}']) {
			const selected = await createZeropsArtifactSourceDescriptor(`zerops: [{setup: notes, extra: ${extra}}]`)
			expect(() => compileFabrikaManifest({ ...config, target: { ...config.target, zeropsSetup: 'notes' } }, 'prod', selected)).toThrow(
				'references service',
			)
			const inherited = await createZeropsArtifactSourceDescriptor(
				`zerops: [{setup: notes, extends: base, run: {start: bun server.ts}}, {setup: base, extra: ${extra}}]`,
			)
			expect(() => compileFabrikaManifest({ ...config, target: { ...config.target, zeropsSetup: 'notes' } }, 'prod', inherited)).toThrow(
				'references service',
			)
		}
	})
	test('checks the whole executed document, not only its setups', async () => {
		const descriptor = await createZeropsArtifactSourceDescriptor(
			'project: {envVariables: {X: "\\x24{proxy_FABRIKA_IAM_KEY}"}}\nzerops: [{setup: notes}]',
		)
		expect(() => compileFabrikaManifest({ ...config, target: { ...config.target, zeropsSetup: 'notes' } }, 'prod', descriptor)).toThrow(
			'references service `proxy`',
		)
	})
	test('refuses at registration a selected setup that inherits run, which the deploy could not overlay', async () => {
		const descriptor = await createZeropsArtifactSourceDescriptor('zerops: [{setup: base, run: {start: bun server.ts}}, {setup: notes, extends: base}]')
		expect(() => compileFabrikaManifest({ ...config, target: { ...config.target, zeropsSetup: 'notes' } }, 'prod', descriptor)).toThrow(
			'must declare its own run section',
		)
	})
	test('accepts a sibling setup for another placement, which never reaches this app', async () => {
		const descriptor = await createZeropsArtifactSourceDescriptor(
			'zerops: [{setup: notes}, {setup: other, run: {envVariables: {URL: "\\x24{proxy_FABRIKA_IAM_KEY}"}}}]',
		)
		const manifest = compileFabrikaManifest({ ...config, target: { ...config.target, zeropsSetup: 'notes' } }, 'prod', descriptor)
		expect(manifest.target.sourceDescriptor).toEqual(descriptor)
		expect(prepareZeropsDescriptor(descriptor.contents, 'notes').contents).not.toContain('proxy_FABRIKA_IAM_KEY')
	})
	test('validates the selector at the manifest boundary while preserving original identity', async () => {
		const descriptor = await createZeropsArtifactSourceDescriptor('# original\r\nzerops: [{setup: notes}, {setup: worker}]\r\n')
		expect(() => compileFabrikaManifest(config, 'prod', descriptor)).toThrow('explicit setup selector')
		expect(() => compileFabrikaManifest({ ...config, target: { ...config.target, zeropsSetup: 'missing' } }, 'prod', descriptor)).toThrow(
			'selected setup',
		)
		const manifest = compileFabrikaManifest({ ...config, target: { ...config.target, zeropsSetup: 'worker' } }, 'prod', descriptor)
		expect(manifest.target.sourceDescriptor).toEqual(descriptor)
		await expect(verifyZeropsArtifactSourceDescriptor(manifest.target.sourceDescriptor)).resolves.toBeUndefined()
	})
	test('refuses an unmodelled import field that reads a service the app does not own', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		const stolen = { zerops: [{ setup: 'notesapi', run: { envVariables: { STOLEN: '${proxy_FABRIKA_IAM_KEY}' } } }] }
		expect(() => parseFabrikaManifest(withUnmodelledField(manifest, stolen))).toThrow('Zerops service `notesapi` references service `proxy`')
	})

	test('finds a foreign reference at any depth, in an object or an array element', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		const deep = { zerops: [{ setup: 'notesapi', run: { envVariables: { NESTED: { a: { b: '${proxy_FABRIKA_IAM_KEY}' } } } } }] }
		const inArray = { zerops: [{ setup: 'notesapi', build: { buildCommands: ['bun install', 'echo ${proxy_FABRIKA_IAM_KEY}'] } }] }
		expect(() => parseFabrikaManifest(withUnmodelledField(manifest, deep))).toThrow('references service `proxy`')
		expect(() => parseFabrikaManifest(withUnmodelledField(manifest, inArray))).toThrow('references service `proxy`')
	})

	test('allows a reference to an own service and to the namespace-owned postgres', async () => {
		const manifest = await compileNotes(`${OWN_SETUP}    run:\n      envVariables:\n        URL: \${notesdb_connectionTlsString}/\${notesdb_dbName}\n`)
		const shared = { zerops: [{ setup: 'notesapi', run: { envVariables: { URL: '${postgres_connectionTlsString}/${postgres_dbName}' } } }] }
		expect(parseFabrikaManifest(withUnmodelledField(manifest, shared))).toBeDefined()
	})

	test('refuses a source descriptor that reads a service the app does not own', async () => {
		const descriptor = `${OWN_SETUP}    run:\n      envVariables:\n        STOLEN: \${proxy_FABRIKA_IAM_KEY}\n`
		await expect(compileNotes(descriptor)).rejects.toThrow('zerops.yaml references service `proxy`')
		const manifest = await compileNotes(OWN_SETUP)
		const sourceDescriptor = await createZeropsArtifactSourceDescriptor(descriptor)
		expect(() => parseFabrikaManifest({ ...manifest, target: { ...manifest.target, sourceDescriptor } })).toThrow(
			'zerops.yaml references service `proxy`',
		)
	})

	// Text scanning let all three through; each parses to the byte-identical `${proxy_FABRIKA_IAM_KEY}`.
	test('refuses a reference the YAML text does not spell — block scalar, folded break, escaped `$`', async () => {
		const value = (written: string): string => `${OWN_SETUP}    run:\n      envVariables:\n        STOLEN: ${written}\n`
		const blockScalar = `${OWN_SETUP}    run:\n      envVariables:\n        STOLEN: |\n          # \${proxy_FABRIKA_IAM_KEY}\n`
		const folded = value('"${proxy_FABRIKA_\\\n          IAM_KEY}"')
		const escaped = value('"\\x24{proxy_FABRIKA_IAM_KEY}"')
		for (const descriptor of [blockScalar, folded, escaped]) {
			expect(JSON.stringify(Bun.YAML.parse(descriptor))).toContain('${proxy_FABRIKA_IAM_KEY}')
			await expect(compileNotes(descriptor)).rejects.toThrow('zerops.yaml references service `proxy`')
		}
	})

	test('refuses a descriptor it cannot parse rather than scanning it as text', async () => {
		await expect(compileNotes('zerops:\n  - setup: notesapi\n   bad: [1,\n')).rejects.toThrow('zerops.yaml is not parseable YAML')
	})

	test("accepts the committed example descriptor unchanged, with the app's own database or the namespace's", async () => {
		const descriptor = await exampleDescriptor('zerops.yaml')
		const own = await compileNotes(descriptor)
		const shared = await compileNotes(descriptor, sharedPostgresConfig)
		expect(own.target.sourceDescriptor.contents).toBe(descriptor)
		expect(manifestServiceHostnames(own)).toEqual(['notesdb', 'notesapi'])
		expect(manifestServiceHostnames(shared)).toEqual(['notesapi'])
	})
})
