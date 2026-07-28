import { describe, expect, test } from 'bun:test'
import { Worker } from 'oblaka-iac'
import { defineApp } from '../defineApp'
import { appPlatform, appTarget } from '../target'
import type { AnyAppConfig, AppConfig, ZeropsAppConfig } from '../types'

// `appTarget` is the ONE place the two authoring forms are normalized, so nothing downstream branches on
// config shape. These tests pin both directions: the historical Cloudflare shorthand still resolves to a
// `cloudflare` arm, and a Zerops config resolves to its own without ever growing a `resources`.

const worker = (): Worker => new Worker({ dir: '.', name: 'demo', compatibility_flags: [], bindings: {}, main: 'src/index.ts' })

describe('appTarget', () => {
	test('a bare `resources` IS the cloudflare arm — the historical surface needs no migration', () => {
		const config: AppConfig = defineApp({ id: 'demo', resources: worker })
		const target = appTarget(config)
		expect(target.platform).toBe('cloudflare')
		expect(appPlatform(config)).toBe('cloudflare')
		if (target.platform === 'cloudflare') {
			expect(target.resources({ env: 'stage' }).options.name).toBe('demo')
		}
	})

	test('a zerops config resolves to its own arm, carrying the service declaration', () => {
		const config: ZeropsAppConfig = defineApp({
			id: 'demo',
			target: { platform: 'zerops', services: () => [{ hostname: 'api', type: 'alpine/bun@1.3' }] },
		})
		const target = appTarget(config)
		expect(appPlatform(config)).toBe('zerops')
		expect(target.platform).toBe('zerops')
		if (target.platform === 'zerops') {
			expect(target.services({ env: 'stage' })).toEqual([{ hostname: 'api', type: 'alpine/bun@1.3' }])
		}
	})

	test('both arms are the same union, so a platform-neutral consumer takes `AnyAppConfig`', () => {
		const configs: AnyAppConfig[] = [
			defineApp({ id: 'cf', resources: worker }),
			defineApp({ id: 'zp', target: { platform: 'zerops', services: () => [{ hostname: 'api', type: 'alpine/bun@1.3' }] } }),
		]
		expect(configs.map(appPlatform)).toEqual(['cloudflare', 'zerops'])
	})

	test('defineApp still rejects a missing id on either arm', () => {
		expect(() => defineApp({ id: '', resources: worker })).toThrow('`id` is required')
		expect(() => defineApp({ id: '  ', target: { platform: 'zerops', services: () => [] } })).toThrow('`id` is required')
	})
})
