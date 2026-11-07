/**
 * Annotation image uploads, shared by the local daemon and the canvas-share worker: which images an upload may carry
 * and how a stored upload is served. Runtime-neutral (Bun and workerd).
 */

/** Raster formats only: an SVG or any other active document would run script on the serving origin. */
const UPLOAD_IMAGE_TYPES = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
} as const

export type UploadImageType = keyof typeof UPLOAD_IMAGE_TYPES

export interface UploadImage {
	type: UploadImageType
	extension: (typeof UPLOAD_IMAGE_TYPES)[UploadImageType]
}

export const UPLOAD_IMAGE_REFUSED = 'Only PNG, JPEG, GIF and WebP images are accepted'

function isUploadImageType(type: string): type is UploadImageType {
	return Object.hasOwn(UPLOAD_IMAGE_TYPES, type)
}

function startsWith(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
	return bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte)
}

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0))

function sniffImageType(bytes: Uint8Array): UploadImageType | null {
	if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
	if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
	if (startsWith(bytes, 0, ascii('GIF87a')) || startsWith(bytes, 0, ascii('GIF89a'))) return 'image/gif'
	if (startsWith(bytes, 0, ascii('RIFF')) && startsWith(bytes, 8, ascii('WEBP'))) return 'image/webp'
	return null
}

/**
 * The image an upload carries, or null when its content is not an accepted raster format. The content's signature
 * alone decides: a declared type means different things per runtime (Bun derives it from the file name).
 */
export function parseUploadImage(bytes: Uint8Array): UploadImage | null {
	const type = sniffImageType(bytes)
	if (type === null) return null
	return { type, extension: UPLOAD_IMAGE_TYPES[type] }
}

const EXTENSION_TYPES: Record<string, UploadImageType> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
}

/** The accepted type a stored upload's file extension names. */
export function uploadImageTypeOfExtension(extension: string): UploadImageType | undefined {
	const lower = extension.toLowerCase()
	return Object.hasOwn(EXTENSION_TYPES, lower) ? EXTENSION_TYPES[lower] : undefined
}

/**
 * Response headers for a stored upload. Every upload is served inert (no sniffing, no script, sandboxed), which also
 * covers files stored before the type allowlist; a type outside the allowlist is served as a download.
 */
export function uploadServeHeaders(storedType: string | undefined): Record<string, string> {
	const inert = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }
	if (storedType !== undefined && isUploadImageType(storedType)) return { ...inert, 'Content-Type': storedType }
	return { ...inert, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' }
}
