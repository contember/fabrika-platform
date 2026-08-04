import { describe, expect, test } from 'bun:test'
import { encodeProxyManifestJson, parseProxyManifest, parseProxyManifestJson } from '..'

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

	test('hosts are lower-cased', () => {
		expect(parseProxyManifest(VALID)?.apps[0]?.hosts).toEqual(['one.example.com'])
	})

	test('an empty rule list seals an app', () => {
		expect(parseProxyManifest({ apps: [{ id: 'a', hosts: ['a.test'], upstream: 'a:1', gates: { rules: [] } }] })?.apps[0]?.gates.rules)
			.toEqual([])
	})

	test('an empty app list', () => {
		expect(parseProxyManifest({ apps: [] })).toEqual({ apps: [] })
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
		// Load-bearing for ADR-0021: this scheme builds the login bounce and the handoff callback.
		expect(parseProxyManifest(withScheme('ftp'))).toBeNull()
		expect(parseProxyManifest(withScheme('HTTPS'))).toBeNull()
	})
})

describe('parseProxyManifest — rejects', () => {
	const bad: [string, unknown][] = [
		['a non-object', 'nope'],
		['null', null],
		['a missing apps array', {}],
		['an app with no id', { apps: [{ hosts: ['a'], upstream: 'a:1', gates: { rules: [] } }] }],
		['an app with no gates', { apps: [{ id: 'a', hosts: ['a'], upstream: 'a:1' }] }],
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
})
