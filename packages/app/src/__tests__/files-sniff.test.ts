// What a stored file's first bytes must be for its declared type, the name it records, and the disposition a download
// carries.

import { inlineFileTypes } from '@fabrika/proxy-core/headers'
import { describe, expect, test } from 'bun:test'
import { bytesAreOfType, SNIFFABLE_TYPES } from '../files/sniff'
import { cleanName } from '../files/streams'
import { contentDisposition, FileDownload, fileResponse } from '../files/treatment'

const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: string) => new TextEncoder().encode(value)

describe('sniffing', () => {
	test('each binary type is recognised by its signature only', () => {
		expect(bytesAreOfType('image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true)
		expect(bytesAreOfType('image/png', bytes(0x89, 0x50, 0x4e, 0x47))).toBe(false)
		expect(bytesAreOfType('image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true)
		expect(bytesAreOfType('image/gif', text('GIF89a...'))).toBe(true)
		expect(bytesAreOfType('image/webp', text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe(true)
		expect(bytesAreOfType('image/webp', text('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBe(false)
		expect(bytesAreOfType('application/pdf', text('%PDF-1.7'))).toBe(true)
		expect(bytesAreOfType('application/zip', bytes(0x50, 0x4b, 0x03, 0x04))).toBe(true)
		expect(bytesAreOfType('application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes(0x50, 0x4b, 0x03, 0x04))).toBe(true)
		expect(bytesAreOfType('image/jpeg', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(false)
	})

	test('a text type takes UTF-8 without NUL bytes and without a binary signature', () => {
		expect(bytesAreOfType('text/plain', text('hello, světe'))).toBe(true)
		expect(bytesAreOfType('text/plain', new Uint8Array(0))).toBe(true)
		// A character cut in half by the sniff window is still text.
		expect(bytesAreOfType('text/plain', text('ě').subarray(0, 1))).toBe(true)
		expect(bytesAreOfType('text/plain', bytes(0x68, 0x00, 0x69))).toBe(false)
		expect(bytesAreOfType('text/plain', bytes(0xff, 0xfe, 0x41))).toBe(false)
		expect(bytesAreOfType('text/csv', text('%PDF-1.7'))).toBe(false)
		expect(bytesAreOfType('image/svg+xml', text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true)
	})

	test('an XML type takes text whose first character, after a byte order mark and white space, is <', () => {
		for (const type of ['application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml']) {
			expect(SNIFFABLE_TYPES).toContain(type)
			expect(bytesAreOfType(type, text('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"/>'))).toBe(true)
			expect(bytesAreOfType(type, text('\uFEFF\r\n  <urlset/>'))).toBe(true)
			expect(bytesAreOfType(type, text('{"items": []}'))).toBe(false)
			expect(bytesAreOfType(type, text(''))).toBe(false)
			expect(bytesAreOfType(type, bytes(0x3c, 0x00, 0x61))).toBe(false)
			expect(bytesAreOfType(type, text('%PDF-1.7 <x/>'))).toBe(false)
		}
	})

	test('a type the framework cannot verify never matches', () => {
		expect(SNIFFABLE_TYPES).not.toContain('text/html')
		expect(SNIFFABLE_TYPES).not.toContain('application/xhtml+xml')
		expect(bytesAreOfType('text/html', text('<html>'))).toBe(false)
		expect(bytesAreOfType('application/xhtml+xml', text('<html xmlns="http://www.w3.org/1999/xhtml"/>'))).toBe(false)
		expect(bytesAreOfType('video/mp4', bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70))).toBe(false)
	})
})

describe('the disposition of a download', () => {
	test('only the inert images are inline; SVG and HTML are attachments', () => {
		for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
			expect(contentDisposition(type, null)).toBe('inline')
		}
		for (const type of ['image/svg+xml', 'text/html', 'application/pdf', 'text/plain']) {
			expect(contentDisposition(type, null)).toBe('attachment')
		}
	})

	test('an XML document is an attachment on a plain file row and inline only on a row of an inline kind', () => {
		const shown = inlineFileTypes('inline-file')
		for (const type of ['application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml']) {
			expect(contentDisposition(type, 'feed.xml')).toBe("attachment; filename*=UTF-8''feed.xml")
			expect(contentDisposition(type, 'feed.xml', inlineFileTypes('file'))).toBe("attachment; filename*=UTF-8''feed.xml")
			expect(contentDisposition(type, 'feed.xml', shown)).toBe("inline; filename*=UTF-8''feed.xml")
		}
		expect(contentDisposition('image/png', null, shown)).toBe('inline')
		// Script a browser runs, or a page it renders, is never shown, whatever the row says.
		for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript', 'application/pdf', 'text/plain']) {
			expect(contentDisposition(type, null, shown)).toBe('attachment')
		}
	})

	test('an inline answer keeps the sandbox CSP and nosniff of every download', () => {
		const response = fileResponse(
			new FileDownload({ body: new Blob(['<rss/>']).stream(), size: 6, contentType: 'application/rss+xml', name: 'feed.xml' }),
			inlineFileTypes('inline-file'),
		)
		expect(response.headers.get('Content-Disposition')).toBe("inline; filename*=UTF-8''feed.xml")
		expect(response.headers.get('Content-Type')).toBe('application/rss+xml')
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect(response.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'")
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
	})

	test('a file name cannot end the header or add a parameter', () => {
		expect(contentDisposition('application/pdf', 'a"; filename=evil.html\r\nX: y')).toBe(
			"attachment; filename*=UTF-8''a%22%3B%20filename%3Devil.html%0D%0AX%3A%20y",
		)
		expect(contentDisposition('application/pdf', "zpráva (1)'s.pdf")).toBe("attachment; filename*=UTF-8''zpr%C3%A1va%20%281%29%27s.pdf")
	})
})

describe('the file name a stored file records', () => {
	test('is cut at 255 code points, never inside a character', () => {
		const emoji = '\u{1F600}'
		expect(cleanName(`${'a'.repeat(254)}${emoji}`)).toBe(`${'a'.repeat(254)}${emoji}`)
		expect(cleanName(`${'a'.repeat(255)}${emoji}`)).toBe('a'.repeat(255))
		expect(cleanName(`${'a'.repeat(254)}${emoji}`)?.includes('\uFFFD')).toBe(false)
	})

	test('loses its control characters, and an empty name is none', () => {
		expect(cleanName('a\r\nb.pdf')).toBe('ab.pdf')
		expect(cleanName('  ')).toBeNull()
		expect(cleanName('')).toBeNull()
	})
})
