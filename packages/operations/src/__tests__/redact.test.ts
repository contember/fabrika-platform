import { describe, expect, test } from 'bun:test'
import { buildParsedEvent } from '../ingest.js'
import { redactEventPayload } from '../redact.js'

function redactMessage(message: string): unknown {
	return redactEventPayload({ message })['message']
}

describe('ingest redaction', () => {
	test('redacts from the first # after a token’s first / to the end of the token', () => {
		const cases: Array<[string, string]> = [
			['https://notes.test/s/#key', 'https://notes.test/s/#[redacted]'],
			['/s/#key', '/s/#[redacted]'],
			['/s/#', '/s/#[redacted]'],
			['/s/#a#b/c', '/s/#[redacted]'],
			['a#b/s/#key', 'a#b/s/#[redacted]'],
			['see /s/#k and https://x.test/#j.', 'see /s/#[redacted] and https://x.test/#[redacted]'],
			['"/s/#k"', '"/s/#[redacted]"'],
			["'/s/#k'", "'/s/#[redacted]'"],
			['<a href=/s/#k>link</a>', '<a href=/s/#[redacted]>link</a>'],
			['/s/#k\trest\n/t/#j', '/s/#[redacted]\trest\n/t/#[redacted]'],
			['/s/#k\u00a0rest', '/s/#[redacted]\u00a0rest'],
			['/s/#k\u2028rest', '/s/#[redacted]\u2028rest'],
			['HTTPS://NOTES.TEST/S/#KEY', 'HTTPS://NOTES.TEST/S/#[redacted]'],
		]
		for (const [input, expected] of cases) {
			expect(redactMessage(input)).toBe(expected)
		}
	})

	test('keeps a # that no / precedes in the same token', () => {
		for (const input of ['issue #42', '#/s/', 'a#b c/d', 'no fragment here', '', '#', '/']) {
			expect(redactMessage(input)).toBe(input)
		}
	})

	test('redacts keys like values, and a credential inside or around a fragment', () => {
		expect(redactEventPayload({ '/s/#key': 'px_abc/#k' })).toEqual({ '/s/#[redacted]': 'px_[redacted]/#[redacted]' })
		expect(redactMessage('https://x.test/#px_abc')).toBe('https://x.test/#[redacted]')
	})

	test('runs in time linear in the input on long runs with no fragment', () => {
		const length = 20_000
		const inputs = ['/'.repeat(length), 'a'.repeat(length), `${'a'.repeat(length)}/#`, `${'/'.repeat(length)}#`, `https://${'/'.repeat(length)}`]
		const started = performance.now()
		for (const input of inputs) {
			buildParsedEvent('app-web', { message: input, exception: { values: [{ type: 'Error', value: input }] } }, 100)
		}
		expect(redactMessage(`${'a'.repeat(length)}/#key`)).toBe(`${'a'.repeat(length)}/#[redacted]`)
		expect(performance.now() - started).toBeLessThan(1_000)
	})
})
