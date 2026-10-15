import type { ZeropsSourceDataFile } from '../source/port'

const BLOCK = 512
const END_OF_ARCHIVE = new Uint8Array(BLOCK * 2)

const text = (block: Uint8Array, start: number, length: number): string => {
	const field = block.subarray(start, start + length)
	const end = field.indexOf(0)
	return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end))
}

const octal = (block: Uint8Array, start: number, length: number): number => {
	const raw = text(block, start, length).trim()
	const value = raw === '' ? 0 : Number.parseInt(raw, 8)
	if (!/^[0-7]*$/.test(raw) || !Number.isSafeInteger(value)) throw new Error('the prepared platform archive is not a tar archive')
	return value
}

const blocksOf = (size: number): number => Math.ceil(size / BLOCK) * BLOCK

/** The `path` record of a pax extended header, the form `git archive` uses for a name over 100 bytes. */
const paxPath = (payload: Uint8Array): string | undefined => {
	for (const record of new TextDecoder().decode(payload).split('\n')) {
		const match = /^\d+ path=(.*)$/.exec(record)
		if (match?.[1] !== undefined) return match[1]
	}
	return undefined
}

const header = (path: string, size: number): Uint8Array => {
	const block = new Uint8Array(BLOCK)
	const write = (start: number, value: string): void => void block.set(new TextEncoder().encode(value), start)
	write(0, path)
	write(100, '0000644\0')
	write(108, '0000000\0')
	write(116, '0000000\0')
	write(124, `${size.toString(8).padStart(11, '0')}\0`)
	write(136, '00000000000\0')
	block.fill(0x20, 148, 156)
	write(156, '0')
	write(257, 'ustar\0')
	write(263, '00')
	const checksum = block.reduce((sum, byte) => sum + byte, 0)
	write(148, `${checksum.toString(8).padStart(6, '0')}\0 `)
	return block
}

/**
 * The prepared platform archive plus the one generated data file (ADR-0045): every entry of the commit is copied
 * byte for byte, and the file is appended after the last one. A commit that already holds the path, as a file or
 * as a directory, is refused rather than overridden.
 */
export const archiveWithDataFile = (compressed: Uint8Array<ArrayBuffer>, file: ZeropsSourceDataFile): Uint8Array<ArrayBuffer> => {
	const path = new TextEncoder().encode(file.path)
	if (path.byteLength === 0 || path.byteLength > 100 || file.path.includes('..') || file.path.startsWith('/')) {
		throw new Error(`the data file path \`${file.path}\` is not one a ustar header holds`)
	}
	const tar = Bun.gunzipSync(compressed)
	let offset = 0
	let pendingPath: string | undefined
	for (;;) {
		const block = tar.subarray(offset, offset + BLOCK)
		if (block.byteLength < BLOCK) throw new Error('the prepared platform archive ends without its end-of-archive blocks')
		if (block.every((byte) => byte === 0)) break
		const size = octal(block, 124, 12)
		const type = text(block, 156, 1)
		const content = tar.subarray(offset + BLOCK, offset + BLOCK + size)
		if (type === 'x') {
			pendingPath = paxPath(content)
		} else if (type !== 'g') {
			const prefix = text(block, 345, 155)
			const named = pendingPath ?? (prefix === '' ? text(block, 0, 100) : `${prefix}/${text(block, 0, 100)}`)
			pendingPath = undefined
			const entry = named.replace(/\/$/, '')
			if (entry === file.path || entry.startsWith(`${file.path}/`)) {
				throw new Error(`the platform source already holds \`${file.path}\`, the proxy manifest's place in the build archive`)
			}
		}
		offset += BLOCK + blocksOf(size)
	}
	const contents = new TextEncoder().encode(file.contents)
	const appended = new Uint8Array(offset + BLOCK + blocksOf(contents.byteLength) + END_OF_ARCHIVE.byteLength)
	appended.set(tar.subarray(0, offset))
	appended.set(header(file.path, contents.byteLength), offset)
	appended.set(contents, offset + BLOCK)
	return Bun.gzipSync(appended)
}
