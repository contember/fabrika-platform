/**
 * Manifest parsing. The stance under test: strictness. A manifest with one unreadable rule is
 * rejected whole, because a proxy that boots on a half-understood gate list enforces a gate list
 * nobody wrote.
 */

import { type ContractArtifact, contractDigest, type EndpointRow, isDigest } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { MAX_CSP_ORIGINS } from '../headers'
import {
	contractProxyTable,
	encodeProxyManifestJson,
	isContractProxyApp,
	isProxyHost,
	parseProxyManifest,
	parseProxyManifestJson,
	type ProxyManifest,
} from '../manifest'
import { createVerifyService } from '../service'
import { FakeIam, ISSUER, verifyRequest } from './helpers'

/** The gate rules of the first app; a contract app or no app has none. */
const rulesOf = (manifest: ProxyManifest | null) => {
	const app = manifest?.apps[0]
	return app === undefined || isContractProxyApp(app) ? undefined : app.gates.rules
}

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
		expect(rulesOf(manifest)?.map((rule) => rule.kind)).toEqual(['public', 'service', 'human'])
		expect(rulesOf(manifest)?.map((rule) => rule.path)).toEqual(['/public/*', '/api/*', '/*'])
	})

	test('an application environment id <app>@<env>, the audience the proxy mints for', () => {
		expect(parseProxyManifest({ apps: [{ ...VALID.apps[0], id: 'notes@prod' }] })?.apps[0]?.id).toBe('notes@prod')
	})

	test('hosts are lower-cased', () => {
		expect(parseProxyManifest(VALID)?.apps[0]?.hosts).toEqual(['one.example.com'])
	})

	test('an empty rule list seals an app', () => {
		expect(rulesOf(parseProxyManifest({ apps: [{ id: 'a', hosts: ['a.test'], upstream: 'a:1', gates: { rules: [] } }] })))
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
		expect(rulesOf(manifest)?.[0]).toEqual({ path: '/*', kind: 'public' })
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

describe('contract apps — the endpoint table', () => {
	const invite = {
		id: 'api.workspaces.invite',
		source: { kind: 'mount', name: 'api' },
		kind: 'mutation',
		method: 'POST',
		path: '/api/workspaces.invite',
		callers: ['human'],
		requirement: { kind: 'action', action: 'notes.admin', access: { form: 'in', dimension: 'workspace', from: 'workspaceId' } },
		admission: { contentTypes: ['application/json'], maxBytes: null },
		input: null,
		output: null,
	} satisfies EndpointRow
	const artifact: ContractArtifact = {
		...notesArtifact,
		endpoints: [...notesArtifact.endpoints, invite],
		csp: { ...notesArtifact.csp, connectSrc: [{ origin: 'https://api.maps.example', purpose: 'the map search' }] },
	}
	const app = { id: 'notes@prod', hosts: ['notes.example.com'], upstream: 'notes:3000', ...contractProxyTable(artifact) }

	test('contractProxyTable carries every row with its digest, the reserved prefixes and the contract digest', () => {
		const table = contractProxyTable(artifact)
		expect(table.endpoints.map((row) => row.id)).toEqual(artifact.endpoints.map((row) => row.id))
		expect(table.endpoints.every((row) => isDigest(row.digest))).toBe(true)
		expect(table.reservedPrefixes).toEqual([...artifact.reservedPrefixes])
		expect(table.snapshot).toBe(contractDigest(artifact))
		expect(table.csp).toEqual({ connectSrc: ['https://api.maps.example'], imgSrc: [], frameAncestors: [] })
	})

	test('a directive may name 16 origins', () => {
		const imgSrc = Array.from({ length: MAX_CSP_ORIGINS }, (_, index) => `https://tiles${index}.example`)
		expect(MAX_CSP_ORIGINS).toBe(16)
		expect(parseProxyManifest({ apps: [{ ...app, csp: { ...app.csp, imgSrc } }] })).not.toBeNull()
	})

	test('an Operations ingest origin parses on http and https', () => {
		for (const operationsOrigin of ['https://operations.example.com', 'http://operations.fabrika.localhost']) {
			expect(parseProxyManifest({ apps: [{ ...app, operationsOrigin }] })?.apps[0]).toEqual({ ...app, scheme: 'https', operationsOrigin })
		}
	})

	test('a delegation marks exactly the members.manage and creates endpoints', () => {
		const delegated = contractProxyTable(artifact).endpoints.filter((row) => row.delegation !== null).map((row) => [row.id, row.delegation])
		expect(delegated).toEqual([['api.workspaces.create', 'creates'], ['api.workspaces.invite', 'members']])
	})

	test('a table the producer emitted parses unchanged', () => {
		const parsed = parseProxyManifest({ apps: [app] })
		const parsedApp = parsed?.apps[0]
		expect(parsedApp !== undefined && isContractProxyApp(parsedApp)).toBe(true)
		expect(parsed).toEqual({ apps: [{ ...app, scheme: 'https' }] })
	})

	const [first, ...rest] = app.endpoints
	if (first === undefined) throw new Error('fixture has no endpoint')
	test.each<[string, unknown]>([
		['a digest that does not match its rules', { ...app, endpoints: [{ ...first, path: '/api/other' }, ...rest] }],
		['a digest that is not a digest', { ...app, endpoints: [{ ...first, digest: 'abc' }, ...rest] }],
		['a field the proxy does not understand', { ...app, endpoints: [{ ...first, extra: true }, ...rest] }],
		['a row without its delegation', {
			...app,
			endpoints: [Object.fromEntries(Object.entries(first).filter(([key]) => key !== 'delegation')), ...rest],
		}],
		['callers on an anonymous kind', {
			...app,
			endpoints: app.endpoints.map((row) => row.requirement === null ? { ...row, callers: ['human'] } : row),
		}],
		['a duplicate endpoint', { ...app, endpoints: [first, ...app.endpoints] }],
		['an invalid reserved prefix', { ...app, reservedPrefixes: ['/api/'] }],
		['a snapshot that is not a digest', { ...app, snapshot: 'v1' }],
		['gates beside the table', { ...app, gates: { rules: [] } }],
		['OAuth resources on a contract app', { ...app, oauthResources: [] }],
		['an unknown caller kind', { ...app, endpoints: [{ ...first, callers: ['job'] }, ...rest] }],
		['a CSP origin that is not https', { ...app, csp: { ...app.csp, imgSrc: ['http://tiles.example'] } }],
		['a CSP origin with a path', { ...app, csp: { ...app.csp, connectSrc: ['https://api.example/v1'] } }],
		['a CSP wildcard', { ...app, csp: { ...app.csp, frameAncestors: ['https://*.example.com'] } }],
		['a 17th origin in one directive', {
			...app,
			csp: { ...app.csp, imgSrc: Array.from({ length: MAX_CSP_ORIGINS + 1 }, (_, index) => `https://tiles${index}.example`) },
		}],
		['a CSP source that would end the directive', { ...app, csp: { ...app.csp, connectSrc: ["https://a.example; script-src 'unsafe-inline'"] } }],
		['a table without its CSP origins', Object.fromEntries(Object.entries(app).filter(([key]) => key !== 'csp'))],
		['an Operations origin with a path', { ...app, operationsOrigin: 'https://operations.example.com/api' }],
		['a delegation its digest does not cover', {
			...app,
			endpoints: app.endpoints.map((row) => row.id === 'api.me' ? { ...row, delegation: 'members' } : row),
		}],
	])('refuses %s', (_name, candidate) => {
		expect(parseProxyManifest({ apps: [candidate] })).toBeNull()
	})

	test('refuses an endpoint table beside gates on a gate app', () => {
		expect(parseProxyManifest({ apps: [{ ...VALID.apps[0], endpoints: [] }] })).toBeNull()
	})
})
