/**
 * Manifest parsing. The stance under test: strictness. A manifest with one unreadable rule is
 * rejected whole, because a proxy that boots on a half-understood gate list enforces a gate list
 * nobody wrote.
 */

import { parseProxyManifest } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { ProxyEnvError, readProxyEnv } from '../env'
import { createVerifyService } from '../service'
import { FakeIam, ISSUER, verifyRequest } from './helpers'

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

	test('an empty app list denies every forwarded request', async () => {
		const manifest = parseProxyManifest({ apps: [] })
		if (manifest === null) throw new Error('test manifest rejected')
		const verify = createVerifyService({ manifest, iam: new FakeIam({}), issuer: ISSUER })
		expect((await verify(verifyRequest({ app: 'anything' }))).status).toBe(403)
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
		// A runtime load must refuse what the generator refuses: otherwise route order, not the
		// manifest, decides which app answers for the shared host.
		['two apps claiming one host', {
			apps: [
				{ id: 'a', hosts: ['same.example.com'], upstream: 'a:1', gates: { rules: [] } },
				{ id: 'b', hosts: ['SAME.example.com'], upstream: 'b:1', gates: { rules: [] } },
			],
		}],
		['a host carrying a port, which could never match', {
			apps: [{ id: 'a', hosts: ['x.test:8080'], upstream: 'a:1', gates: { rules: [] } }],
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
	/** Everything required, so each test varies exactly the one variable it is about. */
	const env = (overrides: Record<string, string | undefined> = {}) => ({
		FABRIKA_IAM_URL: 'https://iam.test',
		FABRIKA_IAM_KEY: 'px_proxy',
		...overrides,
	})

	test('requires the IAM url — refusing to boot beats booting misconfigured', () => {
		expect(() => readProxyEnv({})).toThrow(ProxyEnvError)
		expect(() => readProxyEnv(env({ FABRIKA_IAM_URL: '' }))).toThrow(ProxyEnvError)
	})

	test('requires the IAM key: without it every mint 404s, so the proxy would 503 everything', () => {
		expect(() => readProxyEnv({ FABRIKA_IAM_URL: 'https://iam.test' })).toThrow(ProxyEnvError)
		expect(() => readProxyEnv(env({ FABRIKA_IAM_KEY: '' }))).toThrow(ProxyEnvError)
	})

	test('the IAM url is canonicalized to an origin, because `iss` is compared byte for byte', () => {
		expect(readProxyEnv(env({ FABRIKA_IAM_URL: 'https://iam.test/' })).iamUrl).toBe('https://iam.test')
		expect(readProxyEnv(env({ FABRIKA_IAM_URL: 'https://iam.test' })).iamUrl).toBe('https://iam.test')
		expect(readProxyEnv(env({ FABRIKA_IAM_URL: 'https://iam.test:8443/auth/' })).iamUrl).toBe('https://iam.test:8443')
	})

	test('an IAM url that is not an absolute http(s) URL refuses to boot', () => {
		expect(() => readProxyEnv(env({ FABRIKA_IAM_URL: 'iam.test' }))).toThrow(ProxyEnvError)
		expect(() => readProxyEnv(env({ FABRIKA_IAM_URL: 'ftp://iam.test' }))).toThrow(ProxyEnvError)
	})

	test('caches by default, and only an explicit off disables it', () => {
		expect(readProxyEnv(env()).cacheEnabled).toBe(true)
		expect(readProxyEnv(env({ FABRIKA_PROXY_CACHE: 'off' })).cacheEnabled).toBe(false)
		// A typo must not silently change behaviour in either direction.
		expect(readProxyEnv(env({ FABRIKA_PROXY_CACHE: 'OFF' })).cacheEnabled).toBe(true)
	})

	test('a nonsense port or timeout falls back to the default rather than to zero', () => {
		const parsed = readProxyEnv(env({ FABRIKA_PROXY_PORT: 'abc', FABRIKA_IAM_TIMEOUT_MS: '-1' }))
		expect(parsed.port).toBe(9000)
		expect(parsed.iamTimeoutMs).toBeGreaterThan(0)
	})
})
