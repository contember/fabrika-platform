/**
 * Manifest parsing. The stance under test: strictness. A manifest with one unreadable rule is
 * rejected whole, because a proxy that boots on a half-understood gate list enforces a gate list
 * nobody wrote.
 */

import { parseProxyManifest } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
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
