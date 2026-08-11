import { describe, expect, test } from 'bun:test'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	FABRIKA_MANIFEST_VERSION,
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
		const exact = await createZeropsArtifactSourceDescriptor('é'.repeat(ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES / 2))
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

	test('interpolates only declared variables', () => {
		expect(interpolateManifest('image: ${IMAGE_TAG}', ['IMAGE_TAG'], { IMAGE_TAG: 'v2' })).toBe('image: v2')
		expect(() => interpolateManifest('image: ${IMAGE_TAG}', ['IMAGE_TAG'], {})).toThrow('no deploy-time value')
		expect(() => interpolateManifest('image: ${OTHER}', ['IMAGE_TAG'], { OTHER: 'x' })).toThrow('undeclared')
	})
})
