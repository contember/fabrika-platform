// The archive check of the scan pass: what ClamAV can skip without saying so — an LZMA entry, a damaged deflate
// stream, an encrypted entry, bytes outside any entry, a bomb, an archive in an archive in an archive — is refused
// before the scanner sees it; a ZIP whose every entry ClamAV reads in full passes.

import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { ARCHIVE_LIMITS, checkArchive } from '../files/archive'
import { CLEAN_PDF, damagedZip, EICAR, encryptedZip, LZMA_EICAR_ZIP, zipOf } from './fixtures/scan-samples'

const refusal = (bytes: Uint8Array): string | null => {
	const checked = checkArchive(bytes)
	return checked.ok ? null : checked.refusal
}

describe('checkArchive', () => {
	test('a file that is no archive passes, and so does a ZIP of stored and deflated entries, nested once', () => {
		expect(refusal(new TextEncoder().encode(CLEAN_PDF))).toBeNull()
		const inner = zipOf([{ name: 'sheet.xml', bytes: '<x/>', method: 'deflate' }])
		expect(refusal(zipOf([
			{ name: 'a.txt', bytes: 'stored' },
			{ name: 'eicar.txt', bytes: EICAR, method: 'deflate' },
			{ name: 'embedded.xlsx', bytes: inner, method: 'deflate' },
		]))).toBeNull()
		expect(refusal(zipOf([]))).toBeNull()
	})

	test('an LZMA entry, any method but stored and deflate, and encryption are refused', () => {
		expect(refusal(LZMA_EICAR_ZIP)).toBe('unsupported_method')
		expect(refusal(zipOf([{ name: 'a', bytes: 'x', method: 12 }]))).toBe('unsupported_method')
		expect(refusal(encryptedZip())).toBe('encrypted')
		expect(refusal(zipOf([{ name: 'a', bytes: 'x', flags: 0x40 }]))).toBe('encrypted')
	})

	test('a damaged stream, a wrong CRC, bytes outside every entry and a truncated archive are malformed', () => {
		expect(refusal(damagedZip())).toBe('malformed')
		const zip = zipOf([{ name: 'a.txt', bytes: 'hello' }])
		const wrongCrc = zip.slice()
		wrongCrc[30 + 'a.txt'.length] = 0x48 // the stored data no longer matches its CRC
		expect(refusal(wrongCrc)).toBe('malformed')
		expect(refusal(new Uint8Array([...zip, ...new TextEncoder().encode('trailing')]))).toBe('malformed')
		expect(refusal(zip.subarray(0, zip.length - 5))).toBe('malformed')
	})

	test('an archive in an archive in an archive, another archive format, an unreadable appended ZIP and a bomb are refused', () => {
		const deep = zipOf([{ name: 'b.zip', bytes: zipOf([{ name: 'c.zip', bytes: zipOf([{ name: 'd', bytes: 'x' }]) }]) }])
		expect(refusal(deep)).toBe('nested_too_deep')
		expect(refusal(gzipSync(EICAR))).toBe('unsupported_archive')
		expect(refusal(zipOf([{ name: 'a.gz', bytes: gzipSync(EICAR) }]))).toBe('unsupported_archive')
		const bomb = zipOf([{ name: 'zeros', bytes: new Uint8Array(ARCHIVE_LIMITS.maxUnpackedBytes + 1), method: 'deflate' }])
		expect(refusal(bomb)).toBe('too_large_unpacked')
		// A ZIP appended to another file is found by ClamAV too; one it would skip is refused wherever it sits.
		expect(refusal(new Uint8Array([...new TextEncoder().encode(CLEAN_PDF), ...LZMA_EICAR_ZIP]))).toBe('unsupported_archive')
		expect(refusal(new Uint8Array([...new TextEncoder().encode(CLEAN_PDF), ...encryptedZip()]))).toBe('unsupported_archive')
		expect(refusal(new Uint8Array([...new TextEncoder().encode(CLEAN_PDF), ...zipOf([{ name: 'a', bytes: 'x' }])]))).toBeNull()
		const many = zipOf(Array.from({ length: ARCHIVE_LIMITS.maxEntries + 1 }, (_, index) => ({ name: `f${index}`, bytes: '' })))
		expect(refusal(many)).toBe('too_many_entries')
	})
})
