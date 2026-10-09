import { compileEndpointTable, planEndpoint } from '@fabrika/auth-core'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { PLATFORM_CONSOLE_APP_ID, PLATFORM_IAM_APP_ID } from '@fabrika/platform-artifacts/proxy-manifest'
import { isApplicationEntry } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { localPlatformProxyManifest } from '../prepare'

describe('local Operations topology', () => {
	test('the platform proxy admits ingest and the upload, each authenticating itself, and nothing else', () => {
		const operations = localPlatformProxyManifest().apps.find((app) => app.id === OPERATIONS_APP_ID)
		if (operations === undefined || isApplicationEntry(operations)) throw new Error('expected Operations behind its service table')
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
	test('the console is fronted by its table: health and the webhook open, every other row credentialed', () => {
		const control = localPlatformProxyManifest().apps.find((app) => app.id === PLATFORM_CONSOLE_APP_ID)
		if (control === undefined || isApplicationEntry(control)) throw new Error('expected the console behind its service table')
		const table = compileEndpointTable(control)
		const selected = (method: string, path: string) => {
			const plan = planEndpoint(table, method, path)
			return plan.outcome === 'endpoint' ? `${plan.endpoint.kind}:${plan.endpoint.callers.join('+')}` : plan.outcome
		}
		expect(selected('GET', '/healthz')).toBe('health:')
		expect(selected('GET', '/api/health')).toBe('health:')
		expect(selected('POST', '/webhooks/github/local-keyed-alpha')).toBe('protocol:')
		// A machine key or a logged-in human on the three JSON mounts; humans only for the SPA and every
		// path nobody declared, so no anonymous request ever reaches them.
		for (const path of ['/api/rpc', '/iam/admin/rpc', '/operations/api/rpc']) {
			expect(selected('POST', path)).toBe('service:human+machine')
		}
		expect(selected('GET', '/')).toBe('service:human')
		expect(selected('GET', '/assets/console.js')).toBe('service:human')
		// MCP is off locally unless clients are named: `/mcp` is a session row the service answers 404.
		expect(selected('POST', '/mcp')).toBe('service:human')
	})
})

describe('local IAM topology', () => {
	test('IAM is fronted by its table, every surface a protocol row, because it authenticates itself', () => {
		const iam = localPlatformProxyManifest().apps.find((app) => app.id === PLATFORM_IAM_APP_ID)
		if (iam === undefined || isApplicationEntry(iam)) throw new Error('expected IAM behind its service table')
		const table = compileEndpointTable(iam)
		const probes: [string, string][] = [['GET', '/auth/login'], ['GET', '/.well-known/jwks.json'], ['POST', '/admin/rpc'], ['POST', '/auth/mint/key']]
		for (const [method, path] of probes) {
			const plan = planEndpoint(table, method, path)
			expect(plan.outcome === 'endpoint' ? plan.endpoint.kind : plan.outcome).toBe('protocol')
		}
		expect(planEndpoint(table, 'GET', '/undeclared').outcome).toBe('no-endpoint')
	})
})
