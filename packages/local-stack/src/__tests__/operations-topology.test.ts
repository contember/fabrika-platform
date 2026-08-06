import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { applicableGates, compileGates } from '@fabrika/proxy-core'
import { describe, expect, test } from 'bun:test'
import { PLATFORM_CONSOLE_APP_ID, PLATFORM_IAM_APP_ID } from '../../../installation-zerops/zerops/proxy-manifest'
import { localPlatformProxyManifest } from '../prepare'

/** The first matching rule decides when its credential is present, so this is the effective verdict. */
const firstGate = (gates: ReturnType<typeof compileGates>, path: string): string | null => applicableGates(gates, path)[0]?.rule.kind ?? null

describe('local Operations topology', () => {
	test('the platform proxy admits ingest anonymously and nothing else', () => {
		const operations = localPlatformProxyManifest().apps.find((app) => app.id === OPERATIONS_APP_ID)
		expect(operations).toBeDefined()
		if (operations === undefined) return
		expect(operations.upstream).toBe('operations:3000')
		expect(operations.hosts).toEqual(['errors.fabrika.localhost'])
		const gates = compileGates(operations.gates)
		// The SDK's two anonymous entry points — the only routes this host serves.
		expect(firstGate(gates, '/api/123/envelope/')).toBe('public')
		expect(firstGate(gates, '/api/artifacts/source-maps/')).toBe('public')
		// Everything else matches NO rule, so the proxy denies it before Operations is asked. Health,
		// private reconciliation and the operator API are all reached over the private network instead.
		for (const path of ['/healthz', '/private/catalog/reconcile', '/private/releases/reconcile', '/api/issues', '/api/rpc']) {
			expect(applicableGates(gates, path)).toEqual([])
		}
	})
})

describe('local control topology', () => {
	test('the console is fronted by a human gate and opens only health and the webhook', () => {
		const control = localPlatformProxyManifest().apps.find((app) => app.id === PLATFORM_CONSOLE_APP_ID)
		expect(control).toBeDefined()
		if (control === undefined) return
		const gates = compileGates(control.gates)
		for (const path of ['/healthz', '/api/health', '/webhooks/github']) {
			expect(firstGate(gates, path)).toBe('public')
		}
		// A machine key first, a logged-in human otherwise — and the terminal `/*` rule keeps the fall
		// through on the human path, so no anonymous request ever reaches these.
		for (const path of ['/api/namespaces', '/iam/admin/rpc', '/operations/api/rpc']) {
			const kinds = applicableGates(gates, path).map((gate) => gate.rule.kind)
			expect(kinds[0]).toBe('service')
			expect(kinds.slice(1).every((kind) => kind === 'human')).toBe(true)
		}
		// The SPA itself, and every path nobody declared: humans only, never anonymous.
		expect(applicableGates(gates, '/').map((gate) => gate.rule.kind)).toEqual(['human'])
		expect(applicableGates(gates, '/assets/console.js').map((gate) => gate.rule.kind)).toEqual(['human'])
	})
})

describe('local IAM topology', () => {
	test('IAM is public at the proxy because it authenticates itself', () => {
		const iam = localPlatformProxyManifest().apps.find((app) => app.id === PLATFORM_IAM_APP_ID)
		expect(iam).toBeDefined()
		if (iam === undefined) return
		const gates = compileGates(iam.gates)
		for (const path of ['/auth/login', '/.well-known/jwks.json', '/admin/rpc']) {
			expect(firstGate(gates, path)).toBe('public')
		}
	})
})
