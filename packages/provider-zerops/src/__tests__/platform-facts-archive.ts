// The two archives the unpacker probe uploads, and the smallest tar writer that can tell them apart.
//
// WHY NOT `@fabrika/source-zerops`'s writer: that one REWRITES a `git archive` stream and refuses anything
// whose pax global header does not name the commit it was told about, so driving it from a test means
// writing a tar first anyway. It is also a private package, and this one is public. What is under test here
// is the PLATFORM's unpacker, not our rewriter — the point of the probe is that an archive of regular files
// alone fails its build at unpacking, and the same files preceded by one `5` entry per parent directory
// build and deploy. See `docs/reference/zerops-platform.md`.

const BLOCK_BYTES = 512
const HEADER_CHECKSUM_OFFSET = 148
const HEADER_CHECKSUM_BYTES = 8

export interface ArchiveFile {
	path: string
	contents: string
}

/** A ~5-file Bun application: two directory levels, so a flat archive really is missing something. */
export const PROBE_FILES: readonly ArchiveFile[] = [
	{ path: 'package.json', contents: `${JSON.stringify({ name: 'fabrika-unpacker-probe', private: true, type: 'module' }, null, 2)}\n` },
	{ path: 'README.md', contents: 'A throwaway tree uploaded by the platform-facts unpacker probe.\n' },
	{ path: 'src/index.ts', contents: `import { greet } from './lib/greet'\n\nBun.serve({ port: 3000, fetch: () => new Response(greet()) })\n` },
	{ path: 'src/lib/greet.ts', contents: "export const greet = (): string => 'ok'\n" },
]

/** The build descriptor the probe deploys with. `setup` must equal the service's hostname. */
export const probeDescriptor = (hostname: string): string =>
	[
		'zerops:',
		`  - setup: ${hostname}`,
		'    build:',
		'      base:',
		'        - alpine/bun@1.3',
		'      deployFiles:',
		'        - package.json',
		'        - src',
		'    run:',
		'      base: alpine/bun@1.3',
		'      start: bun src/index.ts',
		'      ports:',
		'        - port: 3000',
		'          httpSupport: true',
		'',
	].join('\n')

const writeString = (block: Uint8Array, offset: number, length: number, value: string): void => {
	const bytes = new TextEncoder().encode(value)
	block.set(bytes.subarray(0, length), offset)
}

const writeOctal = (block: Uint8Array, offset: number, length: number, value: number): void => {
	writeString(block, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

/** One 512-byte ustar header. `type` is `'0'` for a regular file and `'5'` for a directory. */
const header = (path: string, mode: number, size: number, type: '0' | '5'): Uint8Array => {
	const block = new Uint8Array(BLOCK_BYTES)
	writeString(block, 0, 100, path)
	writeOctal(block, 100, 8, mode)
	writeOctal(block, 108, 8, 0)
	writeOctal(block, 116, 8, 0)
	writeOctal(block, 124, 12, size)
	writeOctal(block, 136, 12, 0)
	// The checksum is computed with its own field read as spaces, then written back as octal.
	block.fill(0x20, HEADER_CHECKSUM_OFFSET, HEADER_CHECKSUM_OFFSET + HEADER_CHECKSUM_BYTES)
	writeString(block, 156, 1, type)
	writeString(block, 257, 6, 'ustar\0')
	writeString(block, 263, 2, '00')
	const checksum = block.reduce((total, byte) => total + byte, 0)
	writeString(block, HEADER_CHECKSUM_OFFSET, HEADER_CHECKSUM_BYTES, `${checksum.toString(8).padStart(6, '0')}\0 `)
	return block
}

const padding = (size: number): number => (BLOCK_BYTES - (size % BLOCK_BYTES)) % BLOCK_BYTES

/** Every parent of every file, outermost first, each named once. */
const parentDirectories = (files: readonly ArchiveFile[]): string[] => {
	const seen: string[] = []
	for (const file of files) {
		const segments = file.path.split('/')
		for (let depth = 1; depth < segments.length; depth++) {
			const directory = segments.slice(0, depth).join('/')
			if (!seen.includes(directory)) seen.push(directory)
		}
	}
	return seen
}

/**
 * Build the gzipped tarball the probe uploads.
 *
 * With `directoryEntries: false` it holds regular files and nothing else — zero `5` entries — which is the
 * archive that failed its build at unpacking. With `true` each parent directory is named once, mode `0755`,
 * mtime `0`, before the first file beneath it.
 */
export const probeArchive = (options: { directoryEntries: boolean }): ArrayBuffer => {
	const blocks: Uint8Array[] = []
	const encoder = new TextEncoder()
	if (options.directoryEntries) {
		for (const directory of parentDirectories(PROBE_FILES)) {
			blocks.push(header(`${directory}/`, 0o755, 0, '5'))
		}
	}
	for (const file of PROBE_FILES) {
		const contents = encoder.encode(file.contents)
		blocks.push(header(file.path, 0o644, contents.byteLength, '0'))
		blocks.push(contents)
		const tail = padding(contents.byteLength)
		if (tail > 0) blocks.push(new Uint8Array(tail))
	}
	// Two zero blocks end an archive.
	blocks.push(new Uint8Array(BLOCK_BYTES * 2))
	const total = blocks.reduce((sum, block) => sum + block.byteLength, 0)
	const tar = new Uint8Array(total)
	let offset = 0
	for (const block of blocks) {
		tar.set(block, offset)
		offset += block.byteLength
	}
	const gzipped = Bun.gzipSync(tar)
	const body = new ArrayBuffer(gzipped.byteLength)
	new Uint8Array(body).set(gzipped)
	return body
}
