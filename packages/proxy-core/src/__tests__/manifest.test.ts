/**
 * Manifest parsing. The stance under test: strictness. A manifest with one unreadable rule is
 * rejected whole, because a proxy that boots on a half-understood gate list enforces a gate list
 * nobody wrote.
 */

import { describe, expect, test } from 'bun:test'
import { encodeProxyManifestJson, isProxyHost, parseProxyManifest, parseProxyManifestJson } from '../manifest'
import { createVerifyService } from '../service'
import { FakeIam, ISSUER, verifyRequest } from './helpers'

const withHost = (host: string) => ({ apps: [{ id: 'a', hosts: [host], upstream: 'a:1', gates: { rules: [] } }] })

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
	test('a well-formed manifest, preserving rule order exactly', () => {
		const manifest = parseProxyManifest(VALID)
		expect(manifest?.apps[0]?.gates.rules.map((rule) => rule.kind)).toEqual(['public', 'service', 'human'])
		expect(manifest?.apps[0]?.gates.rules.map((rule) => rule.path)).toEqual(['/public/*', '/api/*', '/*'])
	})

	test('an application environment id <app>@<env>, the audience the proxy mints for', () => {
		expect(parseProxyManifest({ apps: [{ ...VALID.apps[0], id: 'notes@prod' }] })?.apps[0]?.id).toBe('notes@prod')
	})

	test('hosts are lower-cased', () => {
		expect(parseProxyManifest(VALID)?.apps[0]?.hosts).toEqual(['one.example.com'])
	})

	test('an empty rule list seals an app', () => {
		expect(parseProxyManifest({ apps: [{ id: 'a', hosts: ['a.test'], upstream: 'a:1', gates: { rules: [] } }] })?.apps[0]?.gates.rules)
			.toEqual([])
	})

	test('the literal hostnames a deployment actually names', () => {
		for (const host of ['app.example.com', 'localhost', 'control.fabrika.localhost', 'proxy-292c-8080.prg1.zerops.app', '127.0.0.1', 'a'.repeat(63)]) {
			expect(parseProxyManifest(withHost(host))?.apps[0]?.hosts).toEqual([host])
		}
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

	test('the JSON codec round-trips a manifest', () => {
		const manifest = parseProxyManifest(VALID)
		if (manifest === null) throw new Error('test manifest rejected')
		expect(parseProxyManifestJson(encodeProxyManifestJson(manifest))).toEqual(manifest)
	})
})

describe('scheme — the scheme the BROWSER speaks, which no header can supply', () => {
	const withScheme = (scheme?: unknown) => ({
		apps: [{ id: 'a', hosts: ['a.test'], upstream: 'a:1', gates: { rules: [] }, ...(scheme === undefined ? {} : { scheme }) }],
	})

	test('an absent scheme is https — saying nothing gives you the safe value', () => {
		expect(parseProxyManifest(withScheme())?.apps[0]?.scheme).toBe('https')
	})

	test('an explicit http survives, for local development', () => {
		expect(parseProxyManifest(withScheme('http'))?.apps[0]?.scheme).toBe('http')
	})

	test('an unrecognised scheme is rejected rather than coerced', () => {
		// Load-bearing for ADR-0022: this scheme builds the login bounce and the handoff callback.
		expect(parseProxyManifest(withScheme('ftp'))).toBeNull()
		expect(parseProxyManifest(withScheme('HTTPS'))).toBeNull()
	})

	test('legacy non-string scheme values default to https', () => {
		for (const scheme of [null, false, 1, {}, []]) {
			expect(parseProxyManifest(withScheme(scheme))?.apps[0]?.scheme).toBe('https')
		}
	})
})

describe('parseProxyManifest — rejects', () => {
	const bad: [string, unknown][] = [
		['a non-object', 'nope'],
		['null', null],
		['a missing apps array', {}],
		['an app with no id', { apps: [{ hosts: ['a'], upstream: 'a:1', gates: { rules: [] } }] }],
		['an app with no gates', { apps: [{ id: 'a', hosts: ['a'], upstream: 'a:1' }] }],
		['an app id with @ that is not <app>@<env>', { apps: [{ id: 'notes@', hosts: ['a'], upstream: 'a:1', gates: { rules: [] } }] }],
		['an app id with two @', { apps: [{ id: 'notes@prod@eu', hosts: ['a'], upstream: 'a:1', gates: { rules: [] } }] }],
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
		['an unknown credential location', {
			apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: '/*', kind: 'service', credential: { in: 'body', name: 't' } }] } }],
		}],
		['a credential with no name', {
			apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: '/*', kind: 'service', credential: { in: 'header' } }] } }],
		}],
		['one bad rule among good ones', {
			apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: '/*', kind: 'public' }, { path: '/*', kind: 'nonsense' }] } }],
		}],
		// Uniqueness is a manifest rule, not a generator rule: a runtime load must refuse the same thing.
		['two apps claiming one host', {
			apps: [
				{ id: 'a', hosts: ['same.example.com'], upstream: 'a:1', gates: { rules: [] } },
				{ id: 'b', hosts: ['SAME.example.com'], upstream: 'b:1', gates: { rules: [] } },
			],
		}],
		['one app claiming a host twice', { apps: [{ id: 'a', hosts: ['x.test', 'X.test'], upstream: 'a:1', gates: { rules: [] } }] }],
		['a host carrying a port, which could never match', {
			apps: [{ id: 'a', hosts: ['x.test:8080'], upstream: 'a:1', gates: { rules: [] } }],
		}],
		// Caddy's host matcher reads `*` as a wildcard LABEL, so any of these would answer for hosts this
		// app never declared — every sibling app behind the same proxy included.
		['a bare wildcard host', withHost('*')],
		['a wildcard label', withHost('*.example.com')],
		['a Caddy placeholder', withHost('{http.request.host}')],
		['a host with a space', withHost('ex ample.com')],
		['a host with a glob question mark', withHost('a?.example.com')],
		['an empty label', withHost('a..b')],
		['a label starting with a hyphen', withHost('-a.b')],
		['a trailing dot', withHost('a.b.')],
		['an IDN literal, which the wire carries as punycode or not at all', withHost('münchen.example')],
		['a label over 63 characters', withHost(`${'a'.repeat(64)}.example.com`)],
		['a host over 253 characters', withHost(Array.from({ length: 5 }, () => 'a'.repeat(50)).join('.'))],
	]

	for (const [name, value] of bad) {
		test(name, () => {
			expect(parseProxyManifest(value)).toBeNull()
		})
	}

	test('a credential on a public rule is ignored', () => {
		const manifest = parseProxyManifest({
			apps: [{ id: 'a', hosts: ['x'], upstream: 'a:1', gates: { rules: [{ path: '/*', kind: 'public', credential: { in: 'query', name: 't' } }] } }],
		})
		expect(manifest?.apps[0]?.gates.rules[0]).toEqual({ path: '/*', kind: 'public' })
	})

	test('malformed JSON', () => {
		expect(parseProxyManifestJson('{')).toBeNull()
	})

	test('strips extensions and omits absent service credentials', () => {
		const app = { id: 'a', hosts: ['a'], upstream: 'a:1', gates: { rules: [] } }
		for (const credential of [undefined, null]) {
			const result = parseProxyManifest({
				apps: [{ ...app, extra: true, gates: { extra: true, rules: [{ kind: 'service', path: '/*', credential, extra: true }] } }],
				extra: true,
			})
			expect(JSON.stringify(result)).toBe(
				'{"apps":[{"id":"a","hosts":["a"],"upstream":"a:1","gates":{"rules":[{"path":"/*","kind":"service"}]},"scheme":"https"}]}',
			)
		}
	})
})

// The manifest is the authority on hosts (ADR-0022): both compositions load it, and on Zerops ONE Caddy
// fronts every app in a namespace, so a host that is a pattern rather than a name is a hijack primitive.
describe('isProxyHost', () => {
	test('accepts a literal LDH hostname and the longest legal label', () => {
		expect(isProxyHost('app.example.com')).toBe(true)
		expect(isProxyHost('a-b.c-d.example')).toBe(true)
		expect(isProxyHost('a'.repeat(63))).toBe(true)
	})

	test('refuses every character a matcher could read as a pattern', () => {
		for (const host of ['*', '*.example.com', '{http.request.host}', 'a?.example.com', 'ex ample.com', 'a/b', 'a:1', 'a@b', 'a\tb']) {
			expect(isProxyHost(host)).toBe(false)
		}
	})

	test('refuses malformed labels and lengths', () => {
		for (const host of ['', '.', 'a..b', '-a.b', 'a-.b', 'a.b.', `${'a'.repeat(64)}.b`, Array.from({ length: 5 }, () => 'a'.repeat(50)).join('.')]) {
			expect(isProxyHost(host)).toBe(false)
		}
	})

	test('judges the lower-cased form: the predicate refuses uppercase, the parser normalises before asking', () => {
		expect(isProxyHost('EXAMPLE.com')).toBe(false)
		expect(parseProxyManifest(withHost('EXAMPLE.com'))?.apps[0]?.hosts).toEqual(['example.com'])
	})
})
