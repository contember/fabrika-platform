import { describe, expect, test } from 'bun:test'
import type { AppEnvDto } from '../lib/api'
import { cloudflareArtifactWithConfigPath, cloudflareConfigPath, parseManifestEditor } from '../lib/manifest-editor'

describe('manifest editor', () => {
	test('keeps provider extensions and forwards the declared version without imposing a provider schema', () => {
		const text = '{"manifestVersion":7,"future":{"nested":[null,true,"value",2]},"__proto__":{"extension":true}}'
		const parsed = parseManifestEditor(text)
		expect(parsed.version).toBe(7)
		expect(JSON.stringify(parsed.payload)).toBe(text)
	})

	test('keeps JSON errors separate from missing or invalid version errors', () => {
		expect(() => parseManifestEditor('{')).toThrow('Paste a valid fabrika.manifest.json.')
		for (
			const text of [
				'null',
				'[]',
				'1',
				'{}',
				'{"manifestVersion":"2"}',
				'{"manifestVersion":0}',
				'{"manifestVersion":1.5}',
				'{"manifestVersion":9007199254740992}',
			]
		) {
			expect(() => parseManifestEditor(text)).toThrow(
				'That file declares no manifestVersion — paste the fabrika.manifest.json that `fabrika app build` wrote.',
			)
		}
	})

	test('edits only configPath, preserving opaque provider keys and the original envelope', () => {
		const payload = parseManifestEditor('{"manifestVersion":1,"configPath":"old.ts","future":[1,{"flag":true}],"__proto__":{"extension":true}}').payload
		const envelope: AppEnvDto['artifact'] = { provider: 'cloudflare', version: 1, payload }
		expect(cloudflareConfigPath(envelope)).toBe('old.ts')
		const edited = cloudflareArtifactWithConfigPath(envelope, 'new.ts')
		expect(JSON.stringify(edited.payload)).toBe(
			'{"manifestVersion":1,"configPath":"new.ts","future":[1,{"flag":true}],"__proto__":{"extension":true}}',
		)
		expect(cloudflareConfigPath(envelope)).toBe('old.ts')
	})

	test('leaves unsupported envelopes untouched and tolerates absent display fields', () => {
		const envelopes: AppEnvDto['artifact'][] = [
			{ provider: 'zerops', version: 1, payload: { configPath: 'other.ts' } },
			{ provider: 'cloudflare', version: 2, payload: { configPath: 'future.ts' } },
			{ provider: 'cloudflare', version: 1, payload: null },
			{ provider: 'cloudflare', version: 1, payload: [] },
		]
		for (const envelope of envelopes) {
			expect(cloudflareConfigPath(envelope)).toBeNull()
			expect(cloudflareArtifactWithConfigPath(envelope, 'new.ts')).toBe(envelope)
		}
		expect(cloudflareConfigPath({ provider: 'cloudflare', version: 1, payload: { configPath: 3 } })).toBeNull()
		expect(cloudflareConfigPath({ provider: 'cloudflare', version: 1, payload: { configPath: '' } })).toBe('')
	})
})
