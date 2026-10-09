import { compileEndpointTable, planEndpoint } from '@fabrika/auth-core'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { PLATFORM_CONSOLE_APP_ID, PLATFORM_IAM_APP_ID } from '@fabrika/platform-artifacts/proxy-manifest'
import { applicableGates, compileGates } from '@fabrika/proxy-core'
import { hasEndpointTable, type InstallationServiceApp, isGateProxyApp } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { localPlatformProxyManifest } from '../prepare'

/** The first matching rule decides when its credential is present, so this is the effective verdict. */
const firstGate = (gates: ReturnType<typeof compileGates>, path: string): string | null => applicableGates(gates, path)[0]?.rule.kind ?? null

const gatesOf = (app: InstallationServiceApp | undefined) => {
	if (app === undefined || !isGateProxyApp(app)) throw new Error('expected an entry protected by gates')
	return compileGates(app.gates)
}

describe('local Operations topology', () => {
	test('the platform proxy admits ingest and the upload, each authenticating itself, and nothing else', () => {
		const operations = localPlatformProxyManifest().apps.find((app) => app.id === OPERATIONS_APP_ID)
		if (operations === undefined || !hasEndpointTable(operations)) throw new Error('expected Operations behind its service table')
		expect(operations.upstream).toBe('operations:3000')
		expect(operations.hosts).toEqual(['errors.fabrika.localhost'])
		const table = compileEndpointTable(operations)
		const selected = (method: string, path: string) => {
			const plan = planEndpoint(table, method, path)
			return plan.outcome === 'endpoint' ? `${plan.endpoint.kind}:${plan.endpoint.id}` : plan.outcome
		}
		// The SDK's two entry points — the only routes this host serves.
		expect(selected('POST', '/api/123/envelope/')).toBe('protocol:ingest')
		expect(selected('POST', '/api/artifacts/source-maps/')).toBe('protocol:source-map-upload')
		// Everything else selects NO row, so the proxy denies it before Operations is asked. Health,
		// private reconciliation and the operator API are all reached over the private network instead.
		for (const path of ['/healthz', '/private/catalog/reconcile', '/private/releases/reconcile', '/api/undeclared-path', '/api/rpc']) {
			expect(selected('POST', path)).toBe('no-endpoint')
		}
	})
})

describe('local control topology', () => {
	test('the console is fronted by a human gate and opens only health and the webhook', () => {
		const control = localPlatformProxyManifest().apps.find((app) => app.id === PLATFORM_CONSOLE_APP_ID)
		expect(control).toBeDefined()
		const gates = gatesOf(control)
		for (const path of ['/healthz', '/api/health', '/webhooks/github', '/webhooks/github/local-keyed-alpha']) {
			expect(firstGate(gates, path)).toBe('public')
		}
		// A machine key first, a logged-in human otherwise — and the terminal `/*` rule keeps the fall
		// through on the human path, so no anonymous request ever reaches these.
		for (const path of ['/api/rpc', '/iam/admin/rpc', '/operations/api/rpc']) {
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
	test('IAM is fronted by its table, every surface a protocol row, because it authenticates itself', () => {
		const iam = localPlatformProxyManifest().apps.find((app) => app.id === PLATFORM_IAM_APP_ID)
		if (iam === undefined || !hasEndpointTable(iam)) throw new Error('expected IAM behind its service table')
		const table = compileEndpointTable(iam)
		const probes: [string, string][] = [['GET', '/auth/login'], ['GET', '/.well-known/jwks.json'], ['POST', '/admin/rpc'], ['POST', '/auth/mint/key']]
		for (const [method, path] of probes) {
			const plan = planEndpoint(table, method, path)
			expect(plan.outcome === 'endpoint' ? plan.endpoint.kind : plan.outcome).toBe('protocol')
		}
		expect(planEndpoint(table, 'GET', '/undeclared').outcome).toBe('no-endpoint')
	})
})
