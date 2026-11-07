import { describe, expect, test } from 'bun:test'
import { clientAddressKey } from '../client-address'

describe('the client an address counts as', () => {
	test.each<[string | null, string | null]>([
		['203.0.113.7', '203.0.113.7'],
		[' 203.0.113.7 ', '203.0.113.7'],
		['203.0.113.7, 198.51.100.1', '203.0.113.7'],
		['2001:DB8:1:2::1', '2001:db8:1:2::/64'],
		['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
		['[2001:db8::1]', '2001:db8:0:0::/64'],
		['fe80::1%eth0', 'fe80:0:0:0::/64'],
		['::ffff:192.0.2.1', '192.0.2.1'],
		[null, null],
		['', null],
		['  ', null],
		['not-an-address', null],
		['256.1.1.1', null],
		['01.2.3.4', null],
		['1::2::3', null],
		['1:2:3:4:5:6:7:8:9', null],
		['a'.repeat(65), null],
	])('%p counts as %p', (header, key) => {
		expect(clientAddressKey(header)).toBe(key)
	})

	test('every address of one /64 is one client, and the next /64 is another', () => {
		expect(clientAddressKey('2001:db8:1:2::1')).toBe(clientAddressKey('2001:db8:1:2:abcd:ef01:2345:6789'))
		expect(clientAddressKey('2001:db8:1:3::1')).not.toBe(clientAddressKey('2001:db8:1:2::1'))
	})
})
