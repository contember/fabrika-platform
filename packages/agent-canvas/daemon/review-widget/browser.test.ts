import { describe, expect, test } from 'bun:test'
import { browserName } from './browser'

describe('browserName', () => {
	test('names the browser, its major version and the operating system', () => {
		expect(browserName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'))
			.toBe('Chrome 141 · Linux')
		expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'))
			.toBe('Edge 141 · Windows')
		expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0')).toBe('Firefox 144 · macOS')
		expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'))
			.toBe('Safari 26 · macOS')
		expect(
			browserName(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
			),
		)
			.toBe('Safari 18 · iOS')
		expect(browserName('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'))
			.toBe('Chrome 141 · Android')
	})

	test('keeps the start of a user agent it does not recognise', () => {
		expect(browserName('curl/8.5.0')).toBe('curl/8.5.0')
	})
})
