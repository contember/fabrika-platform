import {
	BUILDER_APPROVAL_STORAGE_KEY,
	parseBuilderApprovalState,
	parseBuilderInstallationDiscovery,
	parseBuilderPublicOrigin,
} from '@fabrika/control-contract'
import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { CONTROL_PROXY_GATES } from '../../fabrika.gates'
import { controlApp } from '../app'
import { builderPublicResponse } from '../builder-bootstrap'
import { uuidv7 } from '../db'
import type { Env } from '../env'
import { FakeRepoSource } from '../repo-source'
import { unavailableSourceConnection } from '../source/connections'
import { approvalVerifier } from './helpers/builder-pairing'
import { createHarness } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'
import { testIamEnv } from './helpers/tokens'

const configured = { FABRIKA_CONTROL_DOMAIN: 'https://control.test', FABRIKA_IAM_ISSUER: 'https://iam.test' }

function response(path: string, method = 'GET', env = configured): Response {
	const result = builderPublicResponse(
		new Request(`https://untrusted.test${path}`, {
			method,
			headers: { host: 'injected.test', 'x-forwarded-host': 'injected.test', 'x-forwarded-proto': 'http' },
		}),
		env,
		'harbor',
	)
	if (result === null) throw new Error('expected a bootstrap response')
	return result
}

test('discovery returns only configured safe origins and provider; exact public paths accept GET only', async () => {
	const discovery = response('/.well-known/fabrika-builder')
	expect(discovery.status).toBe(200)
	expect(parseBuilderInstallationDiscovery(await discovery.json())).toEqual({
		version: 1,
		controlOrigin: 'https://control.test',
		iamIssuer: 'https://iam.test',
		provider: 'harbor',
	})
	expect(discovery.headers.get('cache-control')).toBe('no-store')
	for (const path of ['/.well-known/fabrika-builder', '/builder/connect']) {
		for (const method of ['POST', 'PUT', 'HEAD', 'OPTIONS']) expect(response(path, method).status).toBe(405)
		expect(response(`${path}?approval=${approvalVerifier}`).status).toBe(400)
		expect(await response(`${path}?approval=${approvalVerifier}`).text()).not.toContain(approvalVerifier)
		expect(builderPublicResponse(new Request(`https://control.test${path}/`), configured, 'harbor')).toBeNull()
	}
	for (const bad of ['ftp://example.test', 'http://remote.test', 'javascript:alert(1)', '']) {
		expect(response('/.well-known/fabrika-builder', 'GET', { ...configured, FABRIKA_CONTROL_DOMAIN: bad }).status).toBe(503)
		expect(response('/.well-known/fabrika-builder', 'GET', { ...configured, FABRIKA_IAM_ISSUER: bad }).status).toBe(503)
	}
	expect(CONTROL_PROXY_GATES.rules.filter((rule) => rule.kind === 'public' && (rule.path.includes('builder') || rule.path.includes('.well-known'))))
		.toEqual([{ path: '/.well-known/fabrika-builder', kind: 'public' }, { path: '/builder/connect', kind: 'public' }])
})

test('origin parser rejects credentials, paths and insecure nonlocal URLs', () => {
	for (
		const value of [
			'https://user:secret@control.test',
			'https://control.test/path',
			'https://control.test/?x=1',
			'https://control.test/#x',
			'http://remote.test',
		]
	) {
		expect(parseBuilderPublicOrigin(value)).toBeNull()
	}
	for (const value of ['https://control.test', 'http://localhost:123', 'http://app.localhost:123', 'http://127.0.0.1:123', 'http://[::1]:123']) {
		expect(parseBuilderPublicOrigin(value)).toBe(value)
	}
})

async function capture(fragment: string, mode = 'ok', origin = 'https://control.test', query = '') {
	const page = response('/builder/connect')
	const html = await page.text()
	const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1]
	if (script === undefined) throw new Error('bootstrap has no capture script')
	const events: string[] = []
	const storage = new Map<string, string>([[BUILDER_APPROVAL_STORAGE_KEY, 'old-proof']])
	const location = {
		origin,
		hash: fragment,
		search: query,
		replace(path: string) {
			events.push(`navigate:${path}`)
		},
	}
	const window = {
		location,
		history: {
			replaceState(_state: unknown, _title: string, path: string) {
				events.push(`strip:${path}`)
				location.hash = ''
				location.search = ''
			},
		},
		sessionStorage: {
			removeItem(key: string) {
				if (mode === 'blocked') throw new Error('storage blocked')
				storage.delete(key)
			},
			setItem(key: string, value: string) {
				events.push('store')
				if (mode === 'full') throw new Error('storage full')
				storage.set(key, value)
			},
			getItem(key: string) {
				return mode === 'lost' ? null : storage.get(key) ?? null
			},
		},
	}
	runInNewContext(script, { window, URLSearchParams }, { timeout: 1000 })
	return { page, html, events, storage, location }
}

test('self-contained bootstrap strips fragment before protected navigation and stores only tab-local proof', async () => {
	const state = { attemptId: uuidv7(), approvalVerifier, expiresAt: Math.floor(Date.now() / 1000) + 500 }
	const captured = await capture(`#attempt=${state.attemptId}&approval=${state.approvalVerifier}&expires=${state.expiresAt}`)
	expect(captured.events).toEqual(['strip:/builder/connect', 'store', 'navigate:/builder/authorize'])
	expect(captured.location.hash).toBe('')
	const value: unknown = JSON.parse(captured.storage.get(BUILDER_APPROVAL_STORAGE_KEY) ?? 'null')
	expect(parseBuilderApprovalState(value)).toEqual(state)
	expect(captured.html).not.toContain(approvalVerifier)
	expect(captured.html).not.toContain('<script src=')
	expect(captured.html).not.toContain('<link')
	expect(captured.page.headers.get('referrer-policy')).toBe('no-referrer')
	expect(captured.page.headers.get('content-security-policy')).toContain("default-src 'none'; script-src 'nonce-")
	expect(captured.page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
})

test('missing, expired, malformed or unstorable proofs never navigate or reuse previous tab state', async () => {
	const attemptId = uuidv7()
	const expiresAt = Math.floor(Date.now() / 1000) + 500
	const fragment = `#attempt=${attemptId}&approval=${approvalVerifier}&expires=${expiresAt}`
	for (
		const bad of [
			'',
			'#',
			'#approval=bad',
			`${fragment}&approval=${approvalVerifier}`,
			`${fragment}&extra=yes`,
			fragment.replace(`${expiresAt}`, '1'),
			fragment.replace(attemptId, '../bad'),
		]
	) {
		const captured = await capture(bad)
		expect(captured.events).toEqual(['strip:/builder/connect'])
		expect(captured.storage.size).toBe(0)
	}
	for (const mode of ['blocked', 'full', 'lost']) {
		const captured = await capture(fragment, mode)
		expect(captured.location.hash).toBe('')
		expect(captured.events.some((event) => event.startsWith('navigate'))).toBe(false)
	}
	for (
		const captured of [await capture(fragment, 'ok', 'https://other.test'), await capture(fragment, 'ok', 'https://control.test', '?approval=bad')]
	) {
		expect(captured.events).toEqual(['strip:/builder/connect'])
		expect(captured.storage.size).toBe(0)
	}
	expect(parseBuilderApprovalState({ attemptId, approvalVerifier, expiresAt: 1 })).toBeNull()
})

test('public bootstrap runs before authentication; protected RPC remains authenticated', async () => {
	const h = createHarness()
	try {
		const env: Env = {
			DB: h.d1,
			REPOSITORIES: h.repositories,
			ASSETS: { fetch: async () => new Response('dashboard') },
			RUN_LOGS: { get: async () => null, put: async () => {}, delete: async () => {} },
			DEPLOY_QUEUE: { send: async () => {} },
			WAIT_UNTIL: () => {},
			REPO_EVENTS: new FakeRepoSource(),
			ENVIRONMENT: 'local',
			...testIamEnv,
			...configured,
		}
		const fetch = (request: Request) =>
			controlApp.fetch(request, { env, provider: fakeControlProvider, sourceConnection: unavailableSourceConnection('harbor') }, { waitUntil() {} })
		expect((await fetch(new Request('https://control.test/builder/connect'))).status).toBe(200)
		expect((await fetch(new Request('https://control.test/.well-known/fabrika-builder'))).status).toBe(200)
		expect(
			(await fetch(
				new Request('https://control.test/api/rpc', { method: 'POST', body: JSON.stringify({ method: 'builderPairing.listOwn', input: {} }) }),
			)).status,
		).toBe(401)
	} finally {
		h.sqlite.close()
	}
})
