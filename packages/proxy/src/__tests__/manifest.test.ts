/**
 * Manifest parsing. The stance under test: strictness. A manifest with one unreadable rule is
 * rejected whole, because a proxy that boots on a half-understood gate list enforces a gate list
 * nobody wrote.
 */

import { describe, expect, test } from 'bun:test'
import { ProxyEnvError, readProxyEnv } from '../env'
import { parseProxyManifest } from '../manifest'

const VALID = {
	apps: [{
		id: 'app-one',
		hosts: ['One.Example.com'],
		upstream: 'one:3000',
		gates: {
			rules: [
				{ path: '/public/*', kind: 'public' },
				{ path: '/api/*', kind: 'service', credential: { in: 'header', name: 'x-token' } },
				{ path: '/*', kind: 'human' },
			],
		},
	}],
}

describe('parseProxyManifest — accepts', () => {
	test('a well-formed manifest, preserving rule ORDER exactly', () => {
		const manifest = parseProxyManifest(VALID)
		expect(manifest?.apps[0]?.gates.rules.map((rule) => rule.kind)).toEqual(['public', 'service', 'human'])
		expect(manifest?.apps[0]?.gates.rules.map((rule) => rule.path)).toEqual(['/public/*', '/api/*', '/*'])
	})

	test('hosts are lower-cased so matching is case-insensitive', () => {
		expect(parseProxyManifest(VALID)?.apps[0]?.hosts).toEqual(['one.example.com'])
	})

	test('an empty rule list — a deliberately sealed app', () => {
		expect(parseProxyManifest({ apps: [{ id: 'a', hosts: ['a.test'], upstream: 'a:1', gates: { rules: [] } }] })?.apps[0]?.gates.rules)
			.toEqual([])
	})

	test('an empty app list', () => {
		expect(parseProxyManifest({ apps: [] })).toEqual({ apps: [] })
	})
})

describe('parseProxyManifest — rejects', () => {
	const bad: [string, unknown][] = [
		['a non-object', 'nope'],
		['null', null],
		['a missing apps array', {}],
		['an app with no id', { apps: [{ hosts: ['a'], upstream: 'a:1', gates: { rules: [] } }] }],
		['an app with no gates at all', { apps: [{ id: 'a', hosts: ['a'], upstream: 'a:1' }] }],
		['an app with no hosts', { apps: [{ id: 'a', hosts: [], upstream: 'a:1', gates: { rules: [] } }] }],
		['an app with no upstream', { apps: [{ id: 'a', hosts: ['a'], gates: { rules: [] } }] }],
		['duplicate app ids', {
			apps: [
				{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [] } },
				{ id: 'a', hosts: ['y'], upstream: 'a:1', gates: { rules: [] } },
			],
		}],
		['an unknown gate kind', { apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: '/*', kind: 'admin' }] } }] }],
		['a relative gate path', { apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: 'api/*', kind: 'public' }] } }] }],
		['a credential in an unknown location', {
			apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: '/*', kind: 'service', credential: { in: 'body', name: 't' } }] } }],
		}],
		['a credential with no name', {
			apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: '/*', kind: 'service', credential: { in: 'header' } }] } }],
		}],
		['one bad rule among good ones — the whole manifest', {
			apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: '/*', kind: 'public' }, { path: '/*', kind: 'nonsense' }] } }],
		}],
	]

	for (const [name, value] of bad) {
		test(name, () => {
			expect(parseProxyManifest(value)).toBeNull()
		})
	}

	test('a credential on a public/human rule is ignored, not silently honoured', () => {
		const manifest = parseProxyManifest({
			apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: '/*', kind: 'public', credential: { in: 'query', name: 't' } }] } }],
		})
		expect(manifest?.apps[0]?.gates.rules[0]).toEqual({ path: '/*', kind: 'public' })
	})
})

describe('readProxyEnv', () => {
	test('requires the IAM url — refusing to boot beats booting misconfigured', () => {
		expect(() => readProxyEnv({})).toThrow(ProxyEnvError)
		expect(() => readProxyEnv({ FABRIKA_IAM_URL: '' })).toThrow(ProxyEnvError)
	})

	test('caches by default, and only an explicit off disables it', () => {
		expect(readProxyEnv({ FABRIKA_IAM_URL: 'https://iam' }).cacheEnabled).toBe(true)
		expect(readProxyEnv({ FABRIKA_IAM_URL: 'https://iam', FABRIKA_PROXY_CACHE: 'off' }).cacheEnabled).toBe(false)
		// A typo must not silently change behaviour in either direction.
		expect(readProxyEnv({ FABRIKA_IAM_URL: 'https://iam', FABRIKA_PROXY_CACHE: 'OFF' }).cacheEnabled).toBe(true)
	})

	test('a nonsense port or timeout falls back to the default rather than to zero', () => {
		const env = readProxyEnv({ FABRIKA_IAM_URL: 'https://iam', FABRIKA_PROXY_PORT: 'abc', FABRIKA_IAM_TIMEOUT_MS: '-1' })
		expect(env.port).toBe(9000)
		expect(env.iamTimeoutMs).toBeGreaterThan(0)
	})

	test('an empty IAM key is treated as absent', () => {
		expect(readProxyEnv({ FABRIKA_IAM_URL: 'https://iam', FABRIKA_IAM_KEY: '' }).iamKey).toBeUndefined()
	})
})
