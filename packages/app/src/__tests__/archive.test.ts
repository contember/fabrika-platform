// The archive check of the scan pass: what ClamAV can skip without saying so — an LZMA entry, a damaged deflate
// stream, an encrypted entry, a ZIP embedded at another offset, a second end record, bytes outside any entry, a bomb,
// an archive in an archive in an archive — is refused before the scanner sees it; a ZIP whose every entry ClamAV reads
// in full passes, and so does a file that holds no archive at all.

import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { ARCHIVE_LIMITS, checkArchive } from '../files/archive'
import { CLEAN_PDF, damagedZip, EICAR, encryptedZip, LZMA_EICAR_ZIP, zipOf } from './fixtures/scan-samples'

const zipped = (bytes: Uint8Array): string | null => {
	const checked = checkArchive(bytes, true)
	return checked.ok ? null : checked.refusal
}
const plain = (bytes: Uint8Array): string | null => {
	const checked = checkArchive(bytes, false)
	return checked.ok ? null : checked.refusal
}
const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const joined = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(parts.flatMap((part) => [...part]))

describe('checkArchive', () => {
	test('a file that holds no archive passes, and so does a ZIP of stored and deflated entries, nested once', () => {
		expect(plain(text(CLEAN_PDF))).toBeNull()
		const inner = zipOf([{ name: 'sheet.xml', bytes: '<x/>', method: 'deflate' }])
		expect(zipped(zipOf([
			{ name: 'a.txt', bytes: 'stored' },
			{ name: 'eicar.txt', bytes: EICAR, method: 'deflate' },
			{ name: 'embedded.xlsx', bytes: inner, method: 'deflate' },
			{ name: 'streamed.xml', bytes: '<y/>', method: 'deflate', flags: 0x08 },
		]))).toBeNull()
		expect(zipped(zipOf([]))).toBeNull()
	})

	test('an LZMA entry, any method but stored and deflate, and encryption are refused', () => {
		expect(zipped(LZMA_EICAR_ZIP)).toBe('unsupported_method')
		expect(zipped(zipOf([{ name: 'a', bytes: 'x', method: 12 }]))).toBe('unsupported_method')
		expect(zipped(encryptedZip())).toBe('encrypted')
		expect(zipped(zipOf([{ name: 'a', bytes: 'x', flags: 0x40 }]))).toBe('encrypted')
	})

	test('a damaged stream, a wrong CRC, trailing bytes and a truncated archive are malformed', () => {
		expect(zipped(damagedZip())).toBe('malformed')
		const zip = zipOf([{ name: 'a.txt', bytes: 'hello' }])
		const wrongCrc = zip.slice()
		wrongCrc[30 + 'a.txt'.length] = 0x48 // the stored data no longer matches its CRC
		expect(zipped(wrongCrc)).toBe('malformed')
		expect(zipped(zip.subarray(0, zip.length - 5))).toBe('malformed')
	})

	test('a ZIP that is not at offset 0, or inside a file of another type, is refused whatever its entries are', () => {
		// The case ClamAV opens by its local header and skips: a deflated entry whose sizes are in a data descriptor.
		const streamed = zipOf([{ name: 'eicar.txt', bytes: EICAR, method: 'deflate', flags: 0x08 }])
		expect(plain(joined(text('a'.repeat(512)), streamed))).toBe('embedded_archive')
		expect(plain(joined(text(CLEAN_PDF), zipOf([{ name: 'a', bytes: 'x' }])))).toBe('embedded_archive')
		expect(plain(joined(text(CLEAN_PDF), LZMA_EICAR_ZIP))).toBe('embedded_archive')
		expect(plain(streamed)).toBe('embedded_archive')
		expect(zipped(joined(text('MZ prefix'), streamed))).toBe('embedded_archive')
		// A ZIP signature alone, with no archive around it, is refused too: the rare false rejection fails closed.
		expect(plain(joined(text(CLEAN_PDF), new Uint8Array([0x50, 0x4b, 0x05, 0x06])))).toBe('embedded_archive')
		expect(zipped(zipOf([{ name: 'note.txt', bytes: joined(text('see '), new Uint8Array([0x50, 0x4b, 0x03, 0x04])) }]))).toBe(
			'embedded_archive',
		)
	})

	test('a second end record in the tail, a comment that hides one, or a comment that does not end the file is ambiguous', () => {
		const entries = [{ name: 'eicar.txt', bytes: EICAR, method: 'deflate' as const }, { name: 'harmless.txt', bytes: 'hello' }]
		const real = zipOf(entries)
		// An end record inside the comment whose directory starts at the harmless entry's central record.
		const shadow = joined(new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0, 40, 0, 0, 0, 100, 0, 0, 0, 1, 0]))
		expect(zipped(zipOf(entries, shadow))).toBe('ambiguous_directory')
		expect(zipped(zipOf(entries, text('a fine comment')))).toBeNull()
		const lying = real.slice()
		lying[lying.length - 2] = 9 // a comment length past the end of the file
		expect(zipped(lying)).toBe('ambiguous_directory')
		expect(zipped(zipOf(entries, joined(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))))).toBe('ambiguous_directory')
	})

	test('an archive in an archive in an archive, another archive format, and a bomb are refused', () => {
		const deep = zipOf([{
			name: 'b.zip',
			bytes: zipOf([{ name: 'c.zip', bytes: zipOf([{ name: 'd', bytes: 'x' }]), method: 'deflate' }]),
			method: 'deflate',
		}])
		expect(zipped(deep)).toBe('nested_too_deep')
		expect(plain(gzipSync(EICAR))).toBe('unsupported_archive')
		expect(zipped(zipOf([{ name: 'a.gz', bytes: gzipSync(EICAR) }]))).toBe('unsupported_archive')
		const bomb = zipOf([{ name: 'zeros', bytes: new Uint8Array(ARCHIVE_LIMITS.maxUnpackedBytes + 1), method: 'deflate' }])
		expect(zipped(bomb)).toBe('too_large_unpacked')
		const many = zipOf(Array.from({ length: ARCHIVE_LIMITS.maxEntries + 1 }, (_, index) => ({ name: `f${index}`, bytes: '' })))
		expect(zipped(many)).toBe('too_many_entries')
	})
})
