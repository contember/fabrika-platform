import { describe, expect, test } from 'bun:test'
import { defineApp } from '..'

describe('defineApp', () => {
	test('preserves an open provider-owned config type', () => {
		const config = defineApp({
			id: 'demo',
			pipeline: { build: 'bun run build', vars: ['PUBLIC_URL'] },
			delivery: { provider: 'fake-third-provider', region: 'west' },
		})

		expect(config.delivery.region).toBe('west')
		expect(config.pipeline.vars).toEqual(['PUBLIC_URL'])
	})

	test('rejects an empty app id', () => {
		expect(() => defineApp({ id: '  ' })).toThrow('defineApp: `id` is required and must be a non-empty string')
	})
})
