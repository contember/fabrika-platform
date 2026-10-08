// The type of an upload, read from its first bytes. The request's `Content-Type` only says what the client claims;
// a file is stored only when its bytes are that type. A collection may admit only the types listed here, because
// the framework cannot verify any other.

/** How many leading bytes an upload is judged by. */
export const SNIFF_BYTES = 512

interface Signature {
	readonly types: readonly string[]
	matches(head: Uint8Array): boolean
}

function bytesAt(head: Uint8Array, offset: number, expected: readonly number[]): boolean {
	return head.byteLength >= offset + expected.length && expected.every((byte, index) => head[offset + index] === byte)
}

function asciiAt(head: Uint8Array, offset: number, text: string): boolean {
	return bytesAt(head, offset, [...text].map((char) => char.charCodeAt(0)))
}

const ZIP = [0x50, 0x4b, 0x03, 0x04]

const BINARY_SIGNATURES: readonly Signature[] = [
	{ types: ['image/png'], matches: (head) => bytesAt(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
	{ types: ['image/jpeg'], matches: (head) => bytesAt(head, 0, [0xff, 0xd8, 0xff]) },
	{ types: ['image/gif'], matches: (head) => asciiAt(head, 0, 'GIF87a') || asciiAt(head, 0, 'GIF89a') },
	{ types: ['image/webp'], matches: (head) => asciiAt(head, 0, 'RIFF') && asciiAt(head, 8, 'WEBP') },
	{ types: ['application/pdf'], matches: (head) => asciiAt(head, 0, '%PDF-') },
	{ types: ['application/gzip'], matches: (head) => bytesAt(head, 0, [0x1f, 0x8b]) },
	{
		// An Office Open XML document is a zip archive; its bytes cannot tell it from any other.
		types: [
			'application/zip',
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		],
		matches: (head) => bytesAt(head, 0, ZIP),
	},
]

/** Types judged as text: UTF-8 without NUL bytes, and no binary signature. SVG is text, and always an attachment. */
const TEXT_TYPES: readonly string[] = ['text/plain', 'text/csv', 'text/markdown', 'application/json', 'image/svg+xml']

export const SNIFFABLE_TYPES: readonly string[] = [...BINARY_SIGNATURES.flatMap((signature) => signature.types), ...TEXT_TYPES]

function isText(head: Uint8Array): boolean {
	if (head.includes(0) || BINARY_SIGNATURES.some((signature) => signature.matches(head))) {
		return false
	}
	try {
		// `stream: true` tolerates a character the sniff window cut in half.
		new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
		return true
	} catch {
		return false
	}
}

/** Whether the first bytes of an upload are of `type`; always false for a type the framework cannot verify. */
export function bytesAreOfType(type: string, head: Uint8Array): boolean {
	const signature = BINARY_SIGNATURES.find((candidate) => candidate.types.includes(type))
	if (signature !== undefined) {
		return signature.matches(head)
	}
	return TEXT_TYPES.includes(type) && isText(head)
}
