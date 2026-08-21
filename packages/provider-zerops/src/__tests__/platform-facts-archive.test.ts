// Reads the probe archives back, block by block.
//
// The unpacker rows decide a PLATFORM fact from a build outcome, so the archive has to be the only thing
// that differs between them. A corrupt header or a missing end-of-archive marker would make the
// flat-archive row reach `BUILD_FAILED` for a reason that has nothing to do with directory entries — and
// the row would pass while proving nothing.

import { describe, expect, test } from 'bun:test'
import { PROBE_FILES, probeArchive, probeDescriptor } from './platform-facts-archive'

const BLOCK_BYTES = 512
const CHECKSUM_OFFSET = 148
const CHECKSUM_BYTES = 8

interface Entry {
	path: string
	type: string
	mode: string
	mtime: string
	size: number
	contents: string
}

const field = (block: Uint8Array, offset: number, length: number): string =>
	new TextDecoder().decode(block.subarray(offset, offset + length)).replace(/[\0 ]+$/, '')

/** Recompute the header checksum the way tar defines it: its own field read as spaces. */
const checksumOf = (block: Uint8Array): number => {
	const copy = new Uint8Array(block)
	copy.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_BYTES)
	return copy.reduce((total, byte) => total + byte, 0)
}

const read = (archive: ArrayBuffer): { entries: Entry[]; trailingZeroBlocks: number } => {
	const bytes = Bun.gunzipSync(new Uint8Array(archive))
	expect(bytes.byteLength % BLOCK_BYTES).toBe(0)
	const entries: Entry[] = []
	let offset = 0
	let trailingZeroBlocks = 0
	while (offset < bytes.byteLength) {
		const block = bytes.subarray(offset, offset + BLOCK_BYTES)
		offset += BLOCK_BYTES
		if (block.every((byte) => byte === 0)) {
			trailingZeroBlocks += 1
			continue
		}
		expect(trailingZeroBlocks).toBe(0)
		expect(field(block, 257, 6)).toBe('ustar')
		expect(Number.parseInt(field(block, CHECKSUM_OFFSET, CHECKSUM_BYTES), 8)).toBe(checksumOf(block))
		const size = Number.parseInt(field(block, 124, 12), 8)
		const contents = new TextDecoder().decode(bytes.subarray(offset, offset + size))
		offset += Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES
		entries.push({ path: field(block, 0, 100), type: field(block, 156, 1), mode: field(block, 100, 8), mtime: field(block, 136, 12), size, contents })
	}
	return { entries, trailingZeroBlocks }
}

describe('the unpacker probe archives', () => {
	test('names every parent directory once, outermost first, before the file beneath it', () => {
		const { entries, trailingZeroBlocks } = read(probeArchive({ directoryEntries: true }))

		const directories = entries.filter((entry) => entry.type === '5').map((entry) => entry.path)
		expect(directories).toEqual(['src/', 'src/lib/'])
		for (const directory of entries.filter((entry) => entry.type === '5')) {
			// Mode `0755`, mtime `0` — what the CLI's own archive writes, so nothing else in the header differs.
			expect(directory.mode).toBe('0000755')
			expect(directory.mtime).toBe('00000000000')
			expect(directory.size).toBe(0)
		}
		const firstNested = entries.findIndex((entry) => entry.path.startsWith('src/') && entry.type === '0')
		expect(entries.findIndex((entry) => entry.path === 'src/')).toBeLessThan(firstNested)
		expect(entries.findIndex((entry) => entry.path === 'src/lib/'))
			.toBeLessThan(entries.findIndex((entry) => entry.path === 'src/lib/greet.ts'))
		expect(trailingZeroBlocks).toBe(2)
	})

	test('holds regular files and nothing else in its flat form', () => {
		const { entries, trailingZeroBlocks } = read(probeArchive({ directoryEntries: false }))

		expect(entries.filter((entry) => entry.type === '5')).toEqual([])
		expect(entries.map((entry) => entry.path)).toEqual(PROBE_FILES.map((file) => file.path))
		expect(trailingZeroBlocks).toBe(2)
	})

	test('carries the same files either way, byte for byte', () => {
		const flat = read(probeArchive({ directoryEntries: false })).entries
		const nested = read(probeArchive({ directoryEntries: true })).entries.filter((entry) => entry.type === '0')

		expect(nested.map((entry) => [entry.path, entry.contents])).toEqual(flat.map((entry) => [entry.path, entry.contents]))
		for (const file of PROBE_FILES) {
			expect(flat.find((entry) => entry.path === file.path)?.contents).toBe(file.contents)
		}
	})

	test('builds a descriptor whose setup is the service hostname', () => {
		expect(probeDescriptor('wu1abcdefghij')).toContain('- setup: wu1abcdefghij')
	})
})
