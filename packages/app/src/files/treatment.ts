// The file treatment (ADR-0022 rule 2): the header policy a download carries instead of the application's. Only
// the inert images, and on a row of an inline kind the XML documents, are shown inline; every other type, SVG and HTML
// included, is an attachment, and nothing a download contains can run as this origin. The proxy applies the same
// definition, from `@fabrika/proxy-core/headers`.

import { applyFileTreatment, FILE_TREATMENT, fileDisposition, INLINE_FILE_TYPES, withResponseHeaders } from '@fabrika/proxy-core/headers'

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

/** `inline` is the row's `inlineFileTypes`. */
export function contentDisposition(contentType: string, name: string | null, inline: readonly string[] = INLINE_FILE_TYPES): string {
	return `${fileDisposition(contentType, inline)}${name === null ? '' : filenameParameter(name)}`
}

export function fileResponse(file: FileDownload, inline: readonly string[]): Response {
	const headers = new Headers({
		'Content-Type': file.contentType,
		'Content-Length': String(file.size),
		'Content-Disposition': contentDisposition(file.contentType, file.name, inline),
		// A Range request gets the whole file: ignoring Range is always a valid answer, and no partial path exists to get wrong.
		'Accept-Ranges': 'none',
	})
	applyFileTreatment(headers, FILE_TREATMENT, inline)
	return new Response(file.body, { status: 200, headers })
}

/** An error of a download endpoint, with the file treatment in place of the header policy. */
export function withFileTreatment(response: Response, inline: readonly string[]): Response {
	return withResponseHeaders(response, (headers) => applyFileTreatment(headers, FILE_TREATMENT, inline))
}
