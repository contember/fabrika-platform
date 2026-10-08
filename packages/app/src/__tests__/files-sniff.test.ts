// What an upload's first bytes must be for its declared type, and the disposition a download carries.

import { describe, expect, test } from 'bun:test'
import { bytesAreOfType, SNIFFABLE_TYPES } from '../files/sniff'
import { contentDisposition } from '../files/treatment'

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

	test('a type the framework cannot verify never matches', () => {
		expect(SNIFFABLE_TYPES).not.toContain('text/html')
		expect(bytesAreOfType('text/html', text('<html>'))).toBe(false)
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

	test('a file name cannot end the header or add a parameter', () => {
		expect(contentDisposition('application/pdf', 'a"; filename=evil.html\r\nX: y')).toBe(
			"attachment; filename*=UTF-8''a%22%3B%20filename%3Devil.html%0D%0AX%3A%20y",
		)
		expect(contentDisposition('application/pdf', "zpráva (1)'s.pdf")).toBe("attachment; filename*=UTF-8''zpr%C3%A1va%20%281%29%27s.pdf")
	})
})
