// The archive check of the scan pass. ClamAV answers OK for a ZIP whose entries it skipped (LZMA, a damaged deflate
// stream), so its OK cannot vouch for an archive. Before a scanning collection's file reaches the scanner, the
// framework reads every ZIP itself — an Office Open XML document is one — and admits only what ClamAV reads in full:
// stored or deflated entries, no encryption, a layout in which every byte belongs to an entry or the directory, sizes
// and CRCs that match, bounded counts and sizes, and nested ZIPs to a small depth. Any other archive is refused.

import { inflateRawSync } from 'node:zlib'

export const ARCHIVE_LIMITS = {
	/** Entries of one archive, nested ones counted with their parent's. */
	maxEntries: 1000,
	/** Uncompressed bytes of one archive and everything nested in it. */
	maxUnpackedBytes: 256 * 1024 * 1024,
	/** The outer archive is depth 0; an archive inside it is 1; one inside that is refused. */
	maxDepth: 1,
} as const

/** Why an archive is refused. Each is a reject, never a retry: the bytes will not change. */
export type ArchiveRefusal =
	| 'encrypted'
	| 'unsupported_method'
	| 'zip64'
	| 'malformed'
	| 'too_many_entries'
	| 'too_large_unpacked'
	| 'nested_too_deep'
	| 'unsupported_archive'
	/** A ZIP signature inside a file that is no ZIP, or before a ZIP's first entry. */
	| 'embedded_archive'
	/** More than one end record a scanner could pick, or one whose comment does not end the file. */
	| 'ambiguous_directory'

export type ArchiveCheck = { readonly ok: true } | { readonly ok: false; readonly refusal: ArchiveRefusal }

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const DESCRIPTOR = 0x08074b50
const STORED = 0
const DEFLATED = 8
/** Bit 0: encrypted; bit 6: strong encryption; bit 13: the directory is encrypted. */
const ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000
const HAS_DESCRIPTOR = 0x0008

/** Other archive and compression formats, by their first bytes: the scan cannot vouch for what they hold. */
const OTHER_ARCHIVES: readonly (readonly number[])[] = [
	[0x1f, 0x8b], // gzip
	[0x42, 0x5a, 0x68], // bzip2
	[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
	[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
	[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], // rar
	[0x4d, 0x53, 0x43, 0x46], // cab
	[0x28, 0xb5, 0x2f, 0xfd], // zstd
	[0x4c, 0x5a, 0x49, 0x50], // lzip
	[0x5d, 0x00, 0x00], // lzma
]

class Refused extends Error {
	readonly refusal: ArchiveRefusal

	constructor(refusal: ArchiveRefusal) {
		super(refusal)
		this.refusal = refusal
	}
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
	return bytes.length >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte)
}

function isZip(bytes: Uint8Array): boolean {
	return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
}

/** `ustar` at offset 257: a tar archive, which ClamAV opens but this check does not. */
function isTar(bytes: Uint8Array): boolean {
	return startsWith(bytes, [0x75, 0x73, 0x74, 0x61, 0x72], 257)
}

function isOtherArchive(bytes: Uint8Array): boolean {
	return isTar(bytes) || OTHER_ARCHIVES.some((magic) => startsWith(bytes, magic))
}

/** A ZIP's local header, central header and end record: ClamAV opens a ZIP it finds by any of them, wherever it sits. */
const ZIP_SIGNATURES = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x01, 0x02]), Buffer.from([0x50, 0x4b, 0x05, 0x06])]

/**
 * Whether a ZIP signature appears anywhere: in a file that is no ZIP, it is a ZIP embedded where the check does not
 * look, so it is refused. Random bytes hold one with a chance of about three in 2^32 per byte (roughly one in 1400 for
 * 1 MB of compressed data); such a file is rejected too, which fails closed.
 */
function containsZipSignature(bytes: Uint8Array): boolean {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	return ZIP_SIGNATURES.some((signature) => buffer.includes(signature))
}

/** How often `signature` occurs in `bytes`. */
function occurrences(bytes: Uint8Array, signature: Buffer): number {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let count = 0
	for (let at = buffer.indexOf(signature); at !== -1; at = buffer.indexOf(signature, at + 1)) count++
	return count
}

class Reader {
	readonly #view: DataView

	constructor(readonly bytes: Uint8Array) {
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	}

	u16(at: number): number {
		if (at < 0 || at + 2 > this.bytes.length) throw new Refused('malformed')
		return this.#view.getUint16(at, true)
	}

	u32(at: number): number {
		if (at < 0 || at + 4 > this.bytes.length) throw new Refused('malformed')
		return this.#view.getUint32(at, true)
	}

	slice(start: number, end: number): Uint8Array {
		if (start < 0 || end < start || end > this.bytes.length) throw new Refused('malformed')
		return this.bytes.subarray(start, end)
	}
}

interface Entry {
	readonly flags: number
	readonly method: number
	readonly crc: number
	readonly compressed: number
	readonly uncompressed: number
	readonly name: Uint8Array
	readonly offset: number
}

interface Budget {
	entries: number
	unpacked: number
}

/**
 * The end-of-directory record: the only one a scanner could find in the tail, its comment ending the file exactly and
 * holding no ZIP signature, one disk, no ZIP64. A scanner that picked another record would read another directory.
 */
function endRecord(zip: Reader): { readonly entries: number; readonly directoryStart: number; readonly directoryEnd: number } {
	const length = zip.bytes.length
	const tail = zip.bytes.subarray(Math.max(0, length - 22 - 0xffff))
	if (occurrences(tail, ZIP_SIGNATURES[2] ?? Buffer.alloc(0)) !== 1) throw new Refused('ambiguous_directory')
	for (let at = length - 22; at >= Math.max(0, length - 22 - 0xffff); at--) {
		if (zip.u32(at) !== END) continue
		if (at + 22 + zip.u16(at + 20) !== length) throw new Refused('ambiguous_directory')
		if (containsZipSignature(zip.slice(at + 22, length))) throw new Refused('ambiguous_directory')
		const entries = zip.u16(at + 10)
		const size = zip.u32(at + 12)
		const start = zip.u32(at + 16)
		if (entries === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new Refused('zip64')
		if (zip.u16(at + 4) !== 0 || zip.u16(at + 6) !== 0 || zip.u16(at + 8) !== entries) throw new Refused('malformed')
		if (start + size !== at) throw new Refused('malformed')
		return { entries, directoryStart: start, directoryEnd: at }
	}
	throw new Refused('malformed')
}

function directory(zip: Reader, end: ReturnType<typeof endRecord>): Entry[] {
	const entries: Entry[] = []
	let at = end.directoryStart
	for (let index = 0; index < end.entries; index++) {
		if (zip.u32(at) !== CENTRAL) throw new Refused('malformed')
		const flags = zip.u16(at + 8)
		const method = zip.u16(at + 10)
		const compressed = zip.u32(at + 20)
		const uncompressed = zip.u32(at + 24)
		const nameLength = zip.u16(at + 28)
		const next = at + 46 + nameLength + zip.u16(at + 30) + zip.u16(at + 32)
		if ((flags & ENCRYPTION_FLAGS) !== 0) throw new Refused('encrypted')
		if (method !== STORED && method !== DEFLATED) throw new Refused('unsupported_method')
		if (compressed === 0xffffffff || uncompressed === 0xffffffff || zip.u32(at + 42) === 0xffffffff) throw new Refused('zip64')
		if (zip.u16(at + 34) !== 0 || (method === STORED && compressed !== uncompressed)) throw new Refused('malformed')
		entries.push({
			flags,
			method,
			crc: zip.u32(at + 16),
			compressed,
			uncompressed,
			name: zip.slice(at + 46, at + 46 + nameLength),
			offset: zip.u32(at + 42),
		})
		at = next
	}
	if (at !== end.directoryEnd) throw new Refused('malformed')
	return entries
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index])

/** The entry's compressed bytes, after a local header that agrees with the directory; and where the entry ends. */
function localData(zip: Reader, entry: Entry): { readonly data: Uint8Array; readonly end: number } {
	const at = entry.offset
	if (zip.u32(at) !== LOCAL) throw new Refused('malformed')
	const flags = zip.u16(at + 6)
	if ((flags & ENCRYPTION_FLAGS) !== 0) throw new Refused('encrypted')
	if (zip.u16(at + 8) !== entry.method || (flags & HAS_DESCRIPTOR) !== (entry.flags & HAS_DESCRIPTOR)) throw new Refused('malformed')
	const nameLength = zip.u16(at + 26)
	if (!sameBytes(zip.slice(at + 30, at + 30 + nameLength), entry.name)) throw new Refused('malformed')
	const start = at + 30 + nameLength + zip.u16(at + 28)
	const dataEnd = start + entry.compressed
	const data = zip.slice(start, dataEnd)
	if ((flags & HAS_DESCRIPTOR) === 0) {
		if (zip.u32(at + 14) !== entry.crc || zip.u32(at + 18) !== entry.compressed || zip.u32(at + 22) !== entry.uncompressed) {
			throw new Refused('malformed')
		}
		return { data, end: dataEnd }
	}
	// A data descriptor follows the data, with or without its signature.
	const signed = dataEnd + 4 <= zip.bytes.length && zip.u32(dataEnd) === DESCRIPTOR
	const fields = signed ? dataEnd + 4 : dataEnd
	if (zip.u32(fields) !== entry.crc || zip.u32(fields + 4) !== entry.compressed || zip.u32(fields + 8) !== entry.uncompressed) {
		throw new Refused('malformed')
	}
	return { data, end: fields + 12 }
}

function unpacked(entry: Entry, data: Uint8Array, budget: Budget): Uint8Array {
	budget.unpacked += entry.uncompressed
	if (budget.unpacked > ARCHIVE_LIMITS.maxUnpackedBytes) throw new Refused('too_large_unpacked')
	let content: Uint8Array
	if (entry.method === STORED) {
		content = data
	} else {
		try {
			// One byte more than the directory claims: a longer stream lies about its size.
			content = inflateRawSync(data, { maxOutputLength: entry.uncompressed + 1 })
		} catch {
			throw new Refused('malformed')
		}
	}
	if (content.length !== entry.uncompressed || Bun.hash.crc32(content) !== entry.crc) throw new Refused('malformed')
	return content
}

function checkZip(bytes: Uint8Array, depth: number, budget: Budget): void {
	const zip = new Reader(bytes)
	const end = endRecord(zip)
	const entries = directory(zip, end).sort((left, right) => left.offset - right.offset)
	budget.entries += entries.length
	if (budget.entries > ARCHIVE_LIMITS.maxEntries) throw new Refused('too_many_entries')
	// Every byte belongs to an entry or the directory: nothing hides between them, before the first or after the last.
	let expected = 0
	for (const entry of entries) {
		if (entry.offset !== expected) throw new Refused('malformed')
		const { data, end: entryEnd } = localData(zip, entry)
		expected = entryEnd
		checkContent(unpacked(entry, data, budget), depth, budget)
	}
	if (expected !== end.directoryStart) throw new Refused('malformed')
}

/** A nested entry's content: a ZIP from its first byte is checked in turn; any other archive or ZIP signature is refused. */
function checkContent(content: Uint8Array, depth: number, budget: Budget): void {
	if (isZip(content)) {
		if (depth + 1 > ARCHIVE_LIMITS.maxDepth) throw new Refused('nested_too_deep')
		checkZip(content, depth + 1, budget)
	} else if (isOtherArchive(content)) {
		throw new Refused('unsupported_archive')
	} else if (containsZipSignature(content)) {
		throw new Refused('embedded_archive')
	}
}

/**
 * Whether the scanner can vouch for these bytes. A file of a ZIP-based type (`zipBased`: ZIP and Office Open XML) must
 * be a ZIP from its first byte whose every entry, nested ZIPs included, ClamAV reads in full. Any other file passes
 * only when it holds no archive: no other archive format, and no ZIP signature at any offset.
 */
export function checkArchive(bytes: Uint8Array, zipBased: boolean): ArchiveCheck {
	try {
		if (zipBased) {
			if (!isZip(bytes)) throw new Refused('embedded_archive')
			checkZip(bytes, 0, { entries: 0, unpacked: 0 })
		} else if (isOtherArchive(bytes)) {
			throw new Refused('unsupported_archive')
		} else if (containsZipSignature(bytes)) {
			throw new Refused('embedded_archive')
		}
		return { ok: true }
	} catch (error) {
		if (error instanceof Refused) return { ok: false, refusal: error.refusal }
		throw error
	}
}
