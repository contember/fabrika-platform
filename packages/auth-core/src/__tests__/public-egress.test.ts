// What public egress (ADR-0070) decides from a URL and from an address: the rules the runtime guard and the checker share.

import { describe, expect, test } from 'bun:test'
import { isPublicAddress, normalizedHost, publicEgressRefusal } from '../public-egress'

const refusal = (url: string, hosts: readonly string[] = []): string | null => publicEgressRefusal(new URL(url), new Set(hosts))

describe('publicEgressRefusal', () => {
	test('admits a public name over https and http on the default port', () => {
		expect(refusal('https://www.example.com/robots.txt')).toBeNull()
		expect(refusal('http://shop.example.org/?q=1')).toBeNull()
		expect(refusal('https://WWW.Example.COM./')).toBeNull()
		expect(refusal('https://www.example.com:443/')).toBeNull()
	})

	test.each([
		['ftp://files.example.com/', 'is not https: or http:'],
		['https://www.example.com:8443/', 'port 8443'],
		['http://www.example.com:443/', 'port 443'],
		['http://10.0.0.1/', 'is an IP address'],
		['http://0x7f.1/', 'is an IP address'],
		['http://[fd00::1]/', 'is an IP address'],
		['https://8.8.8.8/', 'is an IP address'],
		['http://localhost/', 'one label'],
		['http://control/', 'one label'],
		['http://api.localhost/', '.localhost'],
		['http://printer.local/', '.local'],
		['http://metadata.google.internal/', '.internal'],
		['http://router.home.arpa/', '.arpa'],
		['https://notes-prod.acme.workers.dev/', '.workers.dev'],
		['http://app.prg1.zerops/', '.zerops'],
	])('refuses %s', (url, reason) => {
		expect(refusal(url)).toContain(reason)
	})

	test("refuses the installation's hosts exactly, not their siblings", () => {
		expect(refusal('https://iam.acme.cz/token', ['iam.acme.cz'])).toContain('is a host of this installation')
		expect(refusal('https://IAM.acme.cz./', ['iam.acme.cz'])).toContain('is a host of this installation')
		expect(refusal('https://www.acme.cz/', ['iam.acme.cz'])).toBeNull()
	})

	test('normalizes a host: lowercase, no trailing dot', () => {
		expect(normalizedHost('Www.Example.COM.')).toBe('www.example.com')
	})
})

describe('isPublicAddress', () => {
	test.each([
		'93.184.216.34',
		'8.8.8.8',
		'1.1.1.1',
		'2606:4700:4700::1111',
		'2a00:1450:4014:80c::200e',
		'::ffff:93.184.216.34',
	])('%s is public', (address) => {
		expect(isPublicAddress(address)).toBe(true)
	})

	test.each([
		'0.0.0.0',
		'10.1.2.3',
		'100.64.0.1',
		'127.0.0.1',
		'169.254.169.254',
		'172.16.0.1',
		'172.31.255.255',
		'192.0.0.8',
		'192.0.2.1',
		'192.168.0.1',
		'198.18.0.1',
		'198.51.100.7',
		'203.0.113.9',
		'224.0.0.1',
		'255.255.255.255',
		'::',
		'::1',
		'fe80::1',
		'fe80::1%eth0',
		'fc00::1',
		'fd12:3456::1',
		'ff02::1',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1',
		'64:ff9b::a00:1',
		'2001::1',
		'2001:db8::1',
		'2002:a00:1::1',
		'2001:10::1',
		'3fff::1',
		'not an address',
		'1.2.3',
		'1::2::3',
	])('%s is not', (address) => {
		expect(isPublicAddress(address)).toBe(false)
	})

	test('a public address just outside each private block is public', () => {
		expect(isPublicAddress('172.32.0.1')).toBe(true)
		expect(isPublicAddress('100.128.0.1')).toBe(true)
		expect(isPublicAddress('11.0.0.1')).toBe(true)
		expect(isPublicAddress('192.169.0.1')).toBe(true)
	})
})
