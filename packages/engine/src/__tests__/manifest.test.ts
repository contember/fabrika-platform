import { defineApp } from '@fabrika/config'
import { describe, expect, test } from 'bun:test'
import { interpolateManifest } from '../drivers/zerops'
import { compileFabrikaManifest, configFromManifest, parseFabrikaManifest } from '../manifest'

const config = defineApp({
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
})

describe('static fabrika manifest', () => {
	test('compiles environment-specific services and declared vars as placeholders', () => {
		process.env['IMAGE_TAG'] = 'must-not-leak'
		const manifest = compileFabrikaManifest(config, 'prod')
		expect(manifest.target.serviceHostnames).toEqual(['notes'])
		expect(manifest.target.importYaml).toContain('${IMAGE_TAG}')
		expect(manifest.target.importYaml).not.toContain('must-not-leak')
		expect(process.env['IMAGE_TAG']).toBe('must-not-leak')
		expect(parseFabrikaManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
	})

	test('rejects version, identity, environment, proxy, and forbidden import drift', () => {
		const manifest = compileFabrikaManifest(config, 'prod')
		expect(() => parseFabrikaManifest({ ...manifest, manifestVersion: 2 })).toThrow('version')
		expect(() => parseFabrikaManifest(manifest, { appId: 'other' })).toThrow('app drift')
		expect(() => parseFabrikaManifest(manifest, { env: 'stage' })).toThrow('environment drift')
		expect(() => parseFabrikaManifest({ ...manifest, target: { ...manifest.target, proxy: { upstream: '', gates: { rules: [] } } } })).toThrow('proxy')
		expect(() => parseFabrikaManifest({ ...manifest, target: { ...manifest.target, importYaml: 'services: []\nenvSecrets:\n  X: value\n' } }))
			.toThrow('forbidden')
	})

	test('turns parsed data into a callback-free driver config', () => {
		const parsed = parseFabrikaManifest(compileFabrikaManifest(config, 'prod'))
		const decoded = configFromManifest(parsed)
		expect(decoded.target.services).toBeUndefined()
		expect(decoded.target.compiled?.serviceHostnames).toEqual(['notes'])
	})

	test('interpolates only declared variables and rejects missing or undeclared placeholders', () => {
		expect(interpolateManifest('image: ${IMAGE_TAG}', ['IMAGE_TAG'], { IMAGE_TAG: 'v2' })).toBe('image: v2')
		expect(() => interpolateManifest('image: ${IMAGE_TAG}', ['IMAGE_TAG'], {})).toThrow('no deploy-time value')
		expect(() => interpolateManifest('image: ${OTHER}', ['IMAGE_TAG'], { OTHER: 'x' })).toThrow('undeclared')
	})
})
