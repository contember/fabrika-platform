import { describe, expect, test } from 'bun:test'
import { compileFabrikaManifest, manifestServiceHostnames, parseFabrikaManifest, renderFabrikaImportYaml, zeropsArtifactCodec } from '../manifest'
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
	test('compiles environment-specific services and declared vars as placeholders', () => {
		process.env['IMAGE_TAG'] = 'must-not-leak'
		const manifest = compileFabrikaManifest(config, 'prod')
		expect(manifestServiceHostnames(manifest)).toEqual(['notes'])
		expect(renderFabrikaImportYaml(manifest)).toContain('${IMAGE_TAG}')
		expect(renderFabrikaImportYaml(manifest)).not.toContain('must-not-leak')
		expect(process.env['IMAGE_TAG']).toBe('must-not-leak')
		expect(parseFabrikaManifest(zeropsArtifactCodec.encode(manifest))).toEqual(manifest)
	})

	test('rejects version, identity, environment, proxy ownership, and forbidden structured import drift', () => {
		const manifest = compileFabrikaManifest(config, 'prod')
		const service = manifest.target.importDocument.services[0]
		if (service === undefined) throw new Error('expected a service')
		expect(() => parseFabrikaManifest({ ...manifest, manifestVersion: 1 })).toThrow('version')
		expect(() => parseFabrikaManifest(manifest, { appId: 'other' })).toThrow('app drift')
		expect(() => parseFabrikaManifest(manifest, { env: 'stage' })).toThrow('environment drift')
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

	test('interpolates only declared variables', () => {
		expect(interpolateManifest('image: ${IMAGE_TAG}', ['IMAGE_TAG'], { IMAGE_TAG: 'v2' })).toBe('image: v2')
		expect(() => interpolateManifest('image: ${IMAGE_TAG}', ['IMAGE_TAG'], {})).toThrow('no deploy-time value')
		expect(() => interpolateManifest('image: ${OTHER}', ['IMAGE_TAG'], { OTHER: 'x' })).toThrow('undeclared')
	})
})
