// A `multipart/form-data` body read part by part as it streams (RFC 7578): what a form that takes files receives. The
// reader never buffers a part's body: each part's bytes are a stream of their own, which the caller consumes to the
// end before it asks for the next part, so a form reads its input and checks its challenge before a file's first byte
// is read. It is strict where browsers are: no preamble, a CRLF or `--` after each delimiter, headers within a bound.
// Anything else is a `MultipartError`, which the form answers 400.

import { Buffer } from 'node:buffer'

/**
 * A body that is not the `multipart/form-data` a form reads (`malformed`), or one whose stream failed before its end
 * (`interrupted`: the client closed the connection). Its message names what is wrong, never a byte of it.
 */
export class MultipartError extends Error {
	override readonly name = 'MultipartError'
	readonly reason: 'malformed' | 'interrupted'

	constructor(message: string, reason: 'malformed' | 'interrupted' = 'malformed') {
		super(message)
		this.reason = reason
	}
}

export interface MultipartPart {
	/** The `name` of its `Content-Disposition`. */
	readonly name: string
	/** Its `filename`, as sent; `null` when the part has none, which is a plain field. */
	readonly filename: string | null
	/** The media type of its `Content-Type`, lower-cased and without parameters; `null` when it has none. */
	readonly contentType: string | null
	/** Its bytes. Read it to the end, or cancel it, before the next part. */
	readonly body: ReadableStream<Uint8Array>
}

export interface MultipartReader {
	/** The next part, or `null` after the closing delimiter. Rejects while the previous part's body is unread. */
	next(): Promise<MultipartPart | null>
	/** Stops reading the body. */
	cancel(): Promise<void>
	/** Why the body broke the format, wherever the break was met (a part's body included); `null` while it did not. */
	failure(): MultipartError | null
}

/** RFC 2046: 1 to 70 characters of a closed set, the last not a space. */
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/
const CRLF = Buffer.from('\r\n')
const HEADERS_END = Buffer.from('\r\n\r\n')

/** The boundary of a `multipart/form-data` `Content-Type`, or `null` when it is another type or names none. */
export function multipartBoundary(contentType: string | null): string | null {
	const [type, ...parameters] = splitParameters(contentType ?? '')
	if (type?.toLowerCase() !== 'multipart/form-data') {
		return null
	}
	for (const parameter of parameters) {
		const equals = parameter.indexOf('=')
		if (equals > 0 && parameter.slice(0, equals).trim().toLowerCase() === 'boundary') {
			const value = unquote(parameter.slice(equals + 1).trim())
			return value !== null && BOUNDARY.test(value) ? value : null
		}
	}
	return null
}

/** `a; b="c;d"; e` → `['a', 'b="c;d"', 'e']`: semicolons inside a quoted string do not split. */
function splitParameters(value: string): string[] {
	const parts: string[] = []
	let current = ''
	let quoted = false
	for (let index = 0; index < value.length; index++) {
		const char = value[index] ?? ''
		if (quoted && char === '\\') {
			current += char + (value[index + 1] ?? '')
			index++
		} else if (char === '"') {
			quoted = !quoted
			current += char
		} else if (char === ';' && !quoted) {
			parts.push(current.trim())
			current = ''
		} else {
			current += char
		}
	}
	parts.push(current.trim())
	return parts
}

/** A parameter value: a token as it is, a quoted string without its quotes and escapes; `null` when malformed. */
function unquote(value: string): string | null {
	if (!value.startsWith('"')) {
		return value === '' || value.includes('"') ? null : value
	}
	if (value.length < 2 || !value.endsWith('"')) {
		return null
	}
	let text = ''
	for (let index = 1; index < value.length - 1; index++) {
		const char = value[index] ?? ''
		if (char === '\\') {
			index++
			text += value[index] ?? ''
		} else if (char === '"') {
			return null
		} else {
			text += char
		}
	}
	return text
}

interface PartHeaders {
	readonly name: string
	readonly filename: string | null
	readonly contentType: string | null
}

function partHeaders(block: Buffer): PartHeaders {
	let disposition: string | null = null
	let contentType: string | null = null
	for (const line of new TextDecoder('utf-8', { fatal: false }).decode(block).split('\r\n')) {
		const colon = line.indexOf(':')
		if (colon <= 0) {
			throw new MultipartError('a part header is not a name and a value')
		}
		const header = line.slice(0, colon).trim().toLowerCase()
		const value = line.slice(colon + 1).trim()
		if (header === 'content-disposition') {
			if (disposition !== null) {
				throw new MultipartError('a part has two Content-Disposition headers')
			}
			disposition = value
		} else if (header === 'content-type') {
			contentType = value.split(';')[0]?.trim().toLowerCase() || null
		}
	}
	const [kind, ...parameters] = splitParameters(disposition ?? '')
	if (kind?.toLowerCase() !== 'form-data') {
		throw new MultipartError('a part is not form-data (Content-Disposition: form-data; name="…")')
	}
	let name: string | null = null
	let filename: string | null = null
	for (const parameter of parameters) {
		const equals = parameter.indexOf('=')
		const key = equals > 0 ? parameter.slice(0, equals).trim().toLowerCase() : ''
		const value = equals > 0 ? unquote(parameter.slice(equals + 1).trim()) : null
		if (key === 'name' || key === 'filename') {
			if (value === null || (key === 'name' ? name : filename) !== null) {
				throw new MultipartError(`a part's ${key} is malformed or given twice`)
			}
			if (key === 'name') {
				name = value
			} else {
				filename = value
			}
		}
	}
	if (name === null || name === '') {
		throw new MultipartError('a part has no name')
	}
	return { name, filename, contentType }
}

/**
 * Reads `body` as `multipart/form-data` with `boundary`. A part's headers hold at most `maxHeaderBytes`; its body is
 * as long as the sender makes it, so the caller bounds what it reads of each.
 */
export function multipartParts(body: ReadableStream<Uint8Array>, boundary: string, options: { readonly maxHeaderBytes: number }): MultipartReader {
	const source = body.getReader()
	const delimiter = Buffer.from(`\r\n--${boundary}`)
	// The body starts with the first delimiter, without the CRLF that precedes every later one.
	let buffer: Buffer = Buffer.from(CRLF)
	let ended = false
	/** A part's body is being read: the next part waits until it ended. */
	let reading = false
	/** The closing delimiter was read: there is no further part. */
	let finished = false
	/** Reading stopped before the closing delimiter: no further part can be told from a missing one. */
	let cancelled = false
	let failed: MultipartError | null = null

	/** A break of the format; once reading was cancelled, the end it meets is the cancellation's, not the sender's. */
	const fail = (message: string, reason: 'malformed' | 'interrupted' = 'malformed'): never => {
		if (cancelled) {
			throw new MultipartError('the body was not read to its end')
		}
		failed = new MultipartError(message, reason)
		throw failed
	}

	/** Reads more of the body into the buffer; `false` once the body ended. */
	async function fill(): Promise<boolean> {
		if (ended) {
			return false
		}
		let next: Awaited<ReturnType<typeof source.read>>
		try {
			next = await source.read()
		} catch {
			// A closed connection, or a body stream that failed: the sender's, never the application's.
			return fail('the body could not be read to its end', 'interrupted')
		}
		if (next.done) {
			ended = true
			return false
		}
		buffer = buffer.byteLength === 0 ? Buffer.from(next.value) : Buffer.concat([buffer, next.value])
		return true
	}

	/** At least `size` bytes in the buffer, or the body ended first. */
	async function want(size: number): Promise<boolean> {
		while (buffer.byteLength < size) {
			if (!(await fill())) {
				return false
			}
		}
		return true
	}

	/** The bytes after a delimiter: `--` closes the body, CRLF starts the next part's headers. */
	async function afterDelimiter(): Promise<'part' | 'end'> {
		if (!(await want(2))) {
			return fail('the body ends inside a delimiter')
		}
		const marker = buffer.subarray(0, 2).toString('latin1')
		buffer = buffer.subarray(2)
		if (marker === '--') {
			return 'end'
		}
		if (marker !== '\r\n') {
			return fail('a delimiter is followed by neither CRLF nor --')
		}
		return 'part'
	}

	async function headers(): Promise<PartHeaders> {
		for (;;) {
			const end = buffer.indexOf(HEADERS_END)
			if (end > options.maxHeaderBytes || (end < 0 && buffer.byteLength > options.maxHeaderBytes)) {
				return fail(`a part's headers are longer than ${options.maxHeaderBytes} bytes`)
			}
			if (end >= 0) {
				const block = buffer.subarray(0, end)
				buffer = buffer.subarray(end + HEADERS_END.byteLength)
				try {
					return partHeaders(block)
				} catch (error) {
					return fail(error instanceof Error ? error.message : 'a part header is malformed')
				}
			}
			if (!(await fill())) {
				return fail("the body ends inside a part's headers")
			}
		}
	}

	function partBody(): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					for (;;) {
						const at = buffer.indexOf(delimiter)
						if (at >= 0) {
							if (at > 0) {
								controller.enqueue(new Uint8Array(buffer.subarray(0, at)))
							}
							buffer = buffer.subarray(at + delimiter.byteLength)
							reading = false
							controller.close()
							return
						}
						// Keep what could be the start of the delimiter; everything before it is the part's.
						const safe = buffer.byteLength - (delimiter.byteLength - 1)
						if (safe > 0) {
							controller.enqueue(new Uint8Array(buffer.subarray(0, safe)))
							buffer = buffer.subarray(safe)
							return
						}
						if (!(await fill())) {
							fail('the body ends inside a part')
						}
					}
				} catch (error) {
					controller.error(error)
				}
			},
			async cancel() {
				cancelled = true
				await source.cancel().catch(() => {})
			},
		})
	}

	let started = false
	return {
		async next(): Promise<MultipartPart | null> {
			if (finished) {
				return null
			}
			if (cancelled) {
				throw new MultipartError('the body was not read to its end')
			}
			if (failed !== null) {
				throw failed
			}
			if (reading) {
				throw new MultipartError("the previous part's body was not read to its end")
			}
			if (!started) {
				started = true
				if (!(await want(delimiter.byteLength)) || buffer.indexOf(delimiter) !== 0) {
					return fail('the body does not start with its boundary')
				}
				buffer = buffer.subarray(delimiter.byteLength)
			}
			if ((await afterDelimiter()) === 'end') {
				finished = true
				// The epilogue is the sender's; nothing reads it.
				await source.cancel().catch(() => {})
				return null
			}
			const found = await headers()
			reading = true
			return Object.freeze({ ...found, body: partBody() })
		},
		async cancel(): Promise<void> {
			cancelled = !finished
			await source.cancel().catch(() => {})
		},
		failure: () => failed,
	}
}
