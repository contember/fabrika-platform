import { describe, expect, test } from 'bun:test'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	FABRIKA_MANIFEST_VERSION,
	type FabrikaImportDocument,
	type FabrikaManifest,
	manifestServiceHostnames,
	parseFabrikaManifest,
	renderFabrikaImportYaml,
	verifyZeropsArtifactSourceDescriptor,
	ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES,
	zeropsArtifactCodec,
} from '../manifest'
import { interpolateManifest } from '../provider'
import type { ZeropsAppConfig } from '../types'

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
			{ hostname: env === 'prod' ? 'notes' : 'notesstage', type: 'alpine/bun@1.3', buildFromGit: process.env['IMAGE_TAG'] },
		],
		proxy: { upstream: 'notes:3000', gates: { rules: [{ path: '/health', kind: 'public' }, { path: '/*', kind: 'human' }] } },
	},
}

describe('Zerops static artifact', () => {
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
		expect(() => parseFabrikaManifest({ ...manifest, target: { ...manifest.target, proxy: { upstream: '', gates: { rules: [] } } } })).toThrow('proxy')
		expect(() =>
			parseFabrikaManifest({
				...manifest,
				target: { ...manifest.target, proxy: { upstream: 'other:3000', gates: { rules: [] } } },
			})
		).toThrow('not owned')
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

const withZeropsYaml = (manifest: FabrikaManifest, zeropsYaml: unknown): unknown => ({
	...manifest,
	target: {
		...manifest.target,
		importDocument: {
			services: manifest.target.importDocument.services.map((service) => service['hostname'] === 'notesapi' ? { ...service, zeropsYaml } : service),
		},
	},
})

const exampleDescriptor = async (file: string): Promise<string> =>
	await Bun.file(new URL(`../../../../examples/zerops-app/${file}`, import.meta.url)).text()

describe('cross-service variable references', () => {
	test('checks decoded keys and unknown leaves in unselected setups', async () => {
		for (const extra of ['{"\\x24{proxy_FABRIKA_IAM_KEY}": safe}', '{future: ["\\x24{proxy_FABRIKA_IAM_KEY}"]}']) {
			const descriptor = await createZeropsArtifactSourceDescriptor(`zerops: [{setup: notes}, {setup: unused, extra: ${extra}}]`)
			expect(() => compileFabrikaManifest({ ...config, target: { ...config.target, zeropsSetup: 'notes' } }, 'prod', descriptor)).toThrow(
				'references service',
			)
		}
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
	test('refuses an embedded zeropsYaml that reads a service the app does not own', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		const zeropsYaml = { zerops: [{ setup: 'notesapi', run: { envVariables: { STOLEN: '${proxy_FABRIKA_IAM_KEY}' } } }] }
		expect(() => parseFabrikaManifest(withZeropsYaml(manifest, zeropsYaml))).toThrow('Zerops service `notesapi` references service `proxy`')
	})

	test('finds a foreign reference at any depth, in an object or an array element', async () => {
		const manifest = await compileNotes(OWN_SETUP)
		const deep = { zerops: [{ setup: 'notesapi', run: { envVariables: { NESTED: { a: { b: '${proxy_FABRIKA_IAM_KEY}' } } } } }] }
		const inArray = { zerops: [{ setup: 'notesapi', build: { buildCommands: ['bun install', 'echo ${proxy_FABRIKA_IAM_KEY}'] } }] }
		expect(() => parseFabrikaManifest(withZeropsYaml(manifest, deep))).toThrow('references service `proxy`')
		expect(() => parseFabrikaManifest(withZeropsYaml(manifest, inArray))).toThrow('references service `proxy`')
	})

	test('allows a reference to an own service and to the namespace-owned postgres', async () => {
		const manifest = await compileNotes(`${OWN_SETUP}    run:\n      envVariables:\n        URL: \${notesdb_connectionTlsString}/\${notesdb_dbName}\n`)
		const zeropsYaml = { zerops: [{ setup: 'notesapi', run: { envVariables: { URL: '${postgres_connectionTlsString}/${postgres_dbName}' } } }] }
		expect(parseFabrikaManifest(withZeropsYaml(manifest, zeropsYaml))).toBeDefined()
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

	test('accepts both committed example descriptors unchanged', async () => {
		const own = await compileNotes(await exampleDescriptor('zerops.yaml'))
		const shared = await compileNotes(await exampleDescriptor('zerops.shared-postgres.yaml'), sharedPostgresConfig)
		expect(own.target.sourceDescriptor.contents).toContain('${notesdb_connectionTlsString}')
		expect(shared.target.sourceDescriptor.contents).toContain('${postgres_connectionTlsString}')
		expect(manifestServiceHostnames(own)).toEqual(['notesdb', 'notesapi'])
		expect(manifestServiceHostnames(shared)).toEqual(['notesapi'])
	})
})
