import { describe, expect, test } from 'bun:test'
import { derivePlatformHosts, parseZeropsSubdomains, platformOrigin } from '../hosts'
import { SUBDOMAINS } from './fake-zerops'

const LISTENERS = [
	{ service: 'iam' as const, port: 8080 },
	{ service: 'control' as const, port: 8082 },
	{ service: 'operations' as const, port: 8083 },
]

describe('the proxy generated subdomains', () => {
	test('are read as one host per published HTTP port', () => {
		const byPort = parseZeropsSubdomains(SUBDOMAINS)
		expect(byPort.get(8080)).toBe('proxy-292c-8080.prg1.zerops.app')
		expect(byPort.get(8086)).toBe('proxy-292c-8086.prg1.zerops.app')
		expect(byPort.size).toBe(6)
	})

	test('the port is the trailing digits of the FIRST label, never of the region or the domain', () => {
		const byPort = parseZeropsSubdomains('https://api-v2-3000.prg1.zerops.app')
		expect([...byPort.keys()]).toEqual([3000])
	})

	test('a line that is not a URL is skipped rather than misread as a host', () => {
		expect(parseZeropsSubdomains('\nnot a url\nhttps://proxy-292c-8080.prg1.zerops.app\n').size).toBe(1)
	})
})

describe('deriving the platform hosts', () => {
	test('binds every platform service to its own listener', () => {
		expect(derivePlatformHosts(SUBDOMAINS, LISTENERS)).toEqual({
			iam: 'proxy-292c-8080.prg1.zerops.app',
			control: 'proxy-292c-8082.prg1.zerops.app',
			operations: 'proxy-292c-8083.prg1.zerops.app',
		})
	})

	test('names every listener it could not find rather than writing a manifest with a guessed host', () => {
		expect(() => derivePlatformHosts('https://proxy-292c-8080.prg1.zerops.app', LISTENERS)).toThrow('control (:8082), operations (:8083)')
	})
})

test('an origin is the scheme and the host, and nothing else', () => {
	expect(platformOrigin('https', 'a.test')).toBe('https://a.test')
	expect(platformOrigin('http', 'a.test')).toBe('http://a.test')
})
