import { describe, expect, test } from 'bun:test'
import { sha256Hex } from '../sha256'

async function webCryptoHex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('sha256Hex', () => {
	test.each([
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
		['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
	])('matches the FIPS 180-4 vector for %j', (text, expected) => {
		expect(sha256Hex(text)).toBe(expected)
	})

	test('matches WebCrypto at every padding boundary and for multi-byte UTF-8', async () => {
		const texts = [...Array.from({ length: 140 }, (_, length) => 'x'.repeat(length)), 'příliš žluťoučký kůň', '🦊'.repeat(40), 'a'.repeat(100_000)]
		for (const text of texts) {
			expect(sha256Hex(text)).toBe(await webCryptoHex(text))
		}
	})
})
