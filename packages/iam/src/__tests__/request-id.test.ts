import { describe, expect, test } from 'bun:test'
import { readRequestId } from '../request-id'

const generate = () => 'generated'

function request(headers: Record<string, string>): Request {
	return new Request('https://iam.test', { headers })
}

describe('readRequestId', () => {
	test('reads only the named header', () => {
		const both = request({ 'X-Request-Id': 'proxy-1', 'cf-ray': '8f1c2a3b4c5d6e7f-PRG' })

		expect(readRequestId(both, 'cf-ray', generate)).toBe('8f1c2a3b4c5d6e7f-PRG')
		expect(readRequestId(both, 'X-Request-Id', generate)).toBe('proxy-1')
	})

	test('generates when the composition names no header, whatever the caller sends', () => {
		const both = request({ 'X-Request-Id': 'proxy-1', 'cf-ray': 'ray-1' })

		expect(readRequestId(both, undefined, generate)).toBe('generated')
		expect(readRequestId(both, '', generate)).toBe('generated')
	})

	test('generates when the named header is absent or empty', () => {
		expect(readRequestId(request({ 'X-Request-Id': 'proxy-1' }), 'cf-ray', generate)).toBe('generated')
		expect(readRequestId(request({ 'cf-ray': '' }), 'cf-ray', generate)).toBe('generated')
	})

	test('keeps a UUID and a 64-character id at their full length', () => {
		const uuid = '0192f3a4-5b6c-7d8e-9f01-23456789abcd'
		expect(readRequestId(request({ 'X-Request-Id': uuid }), 'X-Request-Id', generate)).toBe(uuid)
		expect(readRequestId(request({ 'X-Request-Id': 'a'.repeat(64) }), 'X-Request-Id', generate)).toBe('a'.repeat(64))
	})

	test('replaces an overlong value instead of truncating it', () => {
		expect(readRequestId(request({ 'X-Request-Id': 'a'.repeat(65) }), 'X-Request-Id', generate)).toBe('generated')
	})

	test('replaces a value outside the allowlist', () => {
		for (const value of ['has space', 'semi;colon', 'quote"', 'slash/1', 'ünicode', '<script>']) {
			expect(readRequestId(request({ 'X-Request-Id': value }), 'X-Request-Id', generate)).toBe('generated')
		}
	})

	test('replaces a repeated header, which Headers joins with a comma', () => {
		const headers = new Headers()
		headers.append('X-Request-Id', 'first')
		headers.append('X-Request-Id', 'second')

		expect(readRequestId(new Request('https://iam.test', { headers }), 'X-Request-Id', generate)).toBe('generated')
	})
})
