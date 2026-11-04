// The `egress` entry rule: an exact https origin or `https://*.<domain>[:port]`, written canonically, never a wildcard
// on a public suffix; and the match, one label under the domain on the entry's port.

import { describe, expect, test } from 'bun:test'
import { egressAdmits, type EgressEntry, parseEgressEntry } from '../egress'

const entry = (value: string): EgressEntry => {
	const parsed = parseEgressEntry(value)
	if (!parsed.ok) throw new Error(`${value} ${parsed.problem}`)
	return parsed.entry
}

const problem = (value: string): string => {
	const parsed = parseEgressEntry(value)
	if (parsed.ok) throw new Error(`${value} parsed`)
	return parsed.problem
}

const admits = (value: string, url: string): boolean => egressAdmits([entry(value)], new URL(url))

describe('parseEgressEntry', () => {
	test('reads an exact origin and a pattern, with an explicit port', () => {
		expect(entry('https://api.example.com')).toEqual({ kind: 'origin', origin: 'https://api.example.com', host: 'api.example.com', port: '' })
		expect(entry('https://api.example.com:8443')).toEqual({
			kind: 'origin',
			origin: 'https://api.example.com:8443',
			host: 'api.example.com',
			port: '8443',
		})
		expect(entry('https://*.example.com')).toEqual({ kind: 'pattern', pattern: 'https://*.example.com', domain: 'example.com', port: '' })
		expect(entry('https://*.eu.example.com:8443')).toEqual({
			kind: 'pattern',
			pattern: 'https://*.eu.example.com:8443',
			domain: 'eu.example.com',
			port: '8443',
		})
		expect(entry('https://*.example.co.uk').kind).toBe('pattern')
		expect(entry('https://*.xn--bcher-kva.de').kind).toBe('pattern')
	})

	test('refuses another scheme, http included', () => {
		expect(problem('http://*.example.com')).toBe('is not an https origin')
		expect(problem('http://api.example.com')).toBe('is not an https origin')
		expect(problem('wss://*.example.com')).toBe('is not an https origin')
		expect(problem('api.example.com')).toBe('is not an https origin')
	})

	test('refuses a wildcard anywhere but one leading label', () => {
		expect(problem('https://*.*.example.com')).toBe('has more than one wildcard label (allowed: one leading *.)')
		expect(problem('https://api.*.example.com')).toBe('puts a wildcard elsewhere than one leading label')
		expect(problem('https://*example.com')).toBe('puts a wildcard elsewhere than one leading label')
		expect(problem('https://api-*.example.com')).toBe('puts a wildcard elsewhere than one leading label')
		expect(problem('https://*')).toBe('puts a wildcard elsewhere than one leading label')
	})

	test('refuses a wildcard on a top-level domain or a public suffix', () => {
		for (const suffix of ['com', 'uk', 'co.uk', 'com.au', 'ne.jp', 'gov.cz']) {
			expect(problem(`https://*.${suffix}`)).toContain(`puts its wildcard on the public suffix '${suffix}'`)
		}
		expect(problem('https://*.1.2.3')).toBe('puts its wildcard on an IP address (allowed: a domain name)')
		expect(problem('https://*.0.0.1')).toBe('puts its wildcard on an IP address (allowed: a domain name)')
	})

	test('refuses a spelling that is not canonical, naming the canonical one', () => {
		expect(problem('https://*.Example.com')).toBe("is not written canonically (write it as 'https://*.example.com')")
		expect(problem('https://*.bücher.de')).toBe("is not written canonically (write it as 'https://*.xn--bcher-kva.de')")
		expect(problem('https://*.example.com:443')).toBe("is not written canonically (write it as 'https://*.example.com')")
		expect(problem('https://*.example.com.')).toBe("is not written canonically (write it as 'https://*.example.com')")
		expect(problem('https://*.example.com.:8443')).toBe("is not written canonically (write it as 'https://*.example.com:8443')")
		expect(problem('https://*.example.com/')).toBe("is not written canonically (write it as 'https://*.example.com')")
		expect(problem('https://API.example.com')).toBe("is not written canonically (write it as 'https://api.example.com')")
		expect(problem('https://api.example.com.')).toBe("is not written canonically (write it as 'https://api.example.com')")
	})

	test('refuses a path, a query or credentials', () => {
		expect(problem('https://*.example.com/v1')).toBe('carries a path, query or credentials (allowed: an origin only)')
		expect(problem('https://*.example.com?x=1')).toBe('carries a path, query or credentials (allowed: an origin only)')
		expect(problem('https://user@api.example.com')).toBe('carries a path, query or credentials (allowed: an origin only)')
	})

	test('refuses a host that is no literal name', () => {
		expect(problem('https://[::1]')).toBe('is not an https origin with a literal host')
		expect(problem('https://*.[::1]')).toBe('is not an https origin pattern with a literal domain')
	})
})

describe('egressAdmits', () => {
	test('a pattern admits exactly one label under its domain', () => {
		expect(admits('https://*.example.com', 'https://tenant.example.com/v1')).toBe(true)
		expect(admits('https://*.example.com', 'https://a.b.example.com/')).toBe(false)
		expect(admits('https://*.example.com', 'https://example.com/')).toBe(false)
	})

	test('a pattern matches on a label boundary only', () => {
		expect(admits('https://*.example.com', 'https://evil-example.com/')).toBe(false)
		expect(admits('https://*.example.com', 'https://tenantexample.com/')).toBe(false)
		expect(admits('https://*.example.com', 'https://tenant.example.com.evil.net/')).toBe(false)
		expect(admits('https://*.example.com', 'https://tenant.example.community/')).toBe(false)
	})

	test('a pattern matches the default port, or its explicit one', () => {
		expect(admits('https://*.example.com', 'https://tenant.example.com:443/')).toBe(true)
		expect(admits('https://*.example.com', 'https://tenant.example.com:8443/')).toBe(false)
		expect(admits('https://*.example.com:8443', 'https://tenant.example.com:8443/')).toBe(true)
		expect(admits('https://*.example.com:8443', 'https://tenant.example.com/')).toBe(false)
	})

	test('a pattern admits https only', () => {
		expect(admits('https://*.example.com', 'http://tenant.example.com/')).toBe(false)
		expect(admits('https://*.example.com', 'wss://tenant.example.com/')).toBe(false)
	})

	test('the request host is matched as the URL normalizes it: case, IDN and a trailing dot', () => {
		expect(admits('https://*.example.com', 'https://TENANT.Example.COM/')).toBe(true)
		expect(admits('https://*.example.com', 'https://bücher.example.com/')).toBe(true)
		expect(admits('https://*.xn--bcher-kva.de', 'https://tenant.bücher.de/')).toBe(true)
		expect(admits('https://*.example.com', 'https://tenant.example.com./')).toBe(true)
		expect(admits('https://api.example.com', 'https://api.example.com./')).toBe(true)
		expect(admits('https://*.example.com', 'https://tenant.example.com../')).toBe(false)
	})

	test('an exact origin admits its own host and port only', () => {
		expect(admits('https://api.example.com', 'https://api.example.com/v1?x=1')).toBe(true)
		expect(admits('https://api.example.com', 'https://hooks.example.com/')).toBe(false)
		expect(admits('https://api.example.com', 'https://api.example.com:8443/')).toBe(false)
		expect(admits('https://api.example.com', 'http://api.example.com/')).toBe(false)
	})
})
