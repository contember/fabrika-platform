// The file treatment (ADR-0022 rule 2): the header policy a download carries instead of the application's. Only
// the inert images are shown inline; every other type, SVG and HTML included, is an attachment, and nothing a
// download contains can run as this origin.

/** Raster formats a browser only ever renders as an image. */
const INLINE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** A file the download endpoint answers. `ContractRuntime` turns it into the response, with the file treatment. */
export class FileDownload {
	readonly body: ReadableStream<Uint8Array>
	readonly size: number
	/** The type recorded at upload, which its bytes were checked against; never a type a request sent. */
	readonly contentType: string
	readonly name: string | null

	constructor(file: { readonly body: ReadableStream<Uint8Array>; readonly size: number; readonly contentType: string; readonly name: string | null }) {
		this.body = file.body
		this.size = file.size
		this.contentType = file.contentType
		this.name = file.name
	}
}

/** `filename*` per RFC 8187: percent-encoded UTF-8, so no name can end the header or add a parameter. */
function filenameParameter(name: string): string {
	const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
	return `; filename*=UTF-8''${encoded}`
}

export function contentDisposition(contentType: string, name: string | null): string {
	const disposition = INLINE_TYPES.includes(contentType) ? 'inline' : 'attachment'
	return `${disposition}${name === null ? '' : filenameParameter(name)}`
}

export function fileResponse(file: FileDownload): Response {
	return new Response(file.body, {
		status: 200,
		headers: {
			'Content-Type': file.contentType,
			'Content-Length': String(file.size),
			'Content-Disposition': contentDisposition(file.contentType, file.name),
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "sandbox; default-src 'none'",
			// A revoked user must not read a cached copy.
			'Cache-Control': 'private, no-store',
		},
	})
}
