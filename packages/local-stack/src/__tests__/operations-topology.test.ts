import { applicableGates, compileGates } from '@fabrika/proxy'
import { describe, expect, test } from 'bun:test'
import { localPlatformProxyManifest } from '../prepare'

describe('local Operations topology', () => {
	test('the platform proxy publishes only direct envelope ingest for Operations', () => {
		const operations = localPlatformProxyManifest().apps.find((app) => app.id === 'operations')
		expect(operations).toBeDefined()
		if (operations === undefined) return
		expect(operations.upstream).toBe('operations:3000')
		expect(operations.hosts).toEqual(['errors.fabrika.localhost'])
		const gates = compileGates(operations.gates)
		expect(applicableGates(gates, '/api/123/envelope/').map((gate) => gate.rule.kind)).toEqual(['public'])
		expect(applicableGates(gates, '/api/artifacts/source-maps/').map((gate) => gate.rule.kind)).toEqual(['public'])
		for (const path of ['/healthz', '/private/catalog/reconcile', '/api/issues']) {
			expect(applicableGates(gates, path)).toEqual([])
		}
	})
})
