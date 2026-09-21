import { describe, expect, test } from 'bun:test'
import { parseBuilderOrigin, parseBuilderPreviewUrl } from './urls'

describe('builder origins', () => {
	test('canonicalizes HTTPS and explicit local development origins', () => {
		expect(parseBuilderOrigin('https://CONTROL.example:443/')).toBe('https://control.example')
		for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://control.localhost:3000']) {
			expect(parseBuilderOrigin(origin)).toBe(origin)
		}
	})

	test('rejects non-origins, credentials and misleading loopback names', () => {
		for (
			const value of [
				null,
				42,
				'https://control.example/api',
				'https://control.example/a/..',
				'https://control.example?',
				'https://control.example#',
				'https://user:secret@control.example',
				'https://@control.example',
				'http://control.example',
				'http://localhost.evil.example',
				'http://127.0.0.1.evil.example',
				'http://127.1',
				'http://2130706433',
				'http://0x7f000001',
				'http://localhost.',
				'file:///tmp/project',
				'https://control.example\n',
				'https://control.example\\path',
			]
		) {
			expect(() => parseBuilderOrigin(value)).toThrow(Error)
		}
	})
})

test('preview URLs accept paths, query and fragment but reject credentials and non-HTTP protocols', () => {
	expect(parseBuilderPreviewUrl('http://preview.example/app?theme=dark#view')).toBe('http://preview.example/app?theme=dark#view')
	for (const value of ['javascript:alert(1)', 'file:///tmp/index.html', 'https://user:secret@preview.example', 'https://@preview.example']) {
		expect(() => parseBuilderPreviewUrl(value)).toThrow(Error)
	}
})
