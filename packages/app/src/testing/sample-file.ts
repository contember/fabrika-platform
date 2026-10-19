// A small file the testing kits write: the leading bytes `files/sniff.ts` accepts for its type, then a text marker.

const randomHex = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 8)

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))
const ZIP_HEAD = [0x50, 0x4b, 0x03, 0x04]

/** The leading bytes `files/sniff.ts` accepts for each binary type it verifies; a text type needs none. */
const SAMPLE_HEADS: Readonly<Record<string, readonly number[]>> = {
	'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
	'image/gif': ascii('GIF89a'),
	'image/webp': [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')],
	'application/pdf': ascii('%PDF-1.7\n'),
	'application/gzip': [0x1f, 0x8b, 0x08],
	'application/zip': ZIP_HEAD,
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ZIP_HEAD,
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ZIP_HEAD,
	'application/vnd.openxmlformats-officedocument.presentationml.presentation': ZIP_HEAD,
}
const TEXT_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json', 'image/svg+xml'])

/** A file of the first of `types` the kit can write; `name` (a collection or a kind) names it in the error when none is. */
export function sampleFile(name: string, types: readonly string[]): { readonly type: string; readonly bytes: Uint8Array<ArrayBuffer> } {
	for (const type of types) {
		const head = SAMPLE_HEADS[type] ?? (TEXT_TYPES.has(type) ? [] : undefined)
		if (head !== undefined) return { type, bytes: new Uint8Array([...head, ...ascii(`fabrika test file ${randomHex()}`)]) }
	}
	throw new Error(`files.${name}: none of its types is one the testing kit can write a file of`)
}
