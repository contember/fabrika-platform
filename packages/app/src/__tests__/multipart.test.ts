// The multipart reader a form with files reads its body through: parts in order, each body a stream of its own, and
// every malformed body refused. No database.

import { describe, expect, test } from 'bun:test'
import { multipartBoundary, MultipartError, multipartParts, type MultipartReader } from '../implement/multipart'

const encoder = new TextEncoder()

/** `body` cut into chunks of `size` bytes, so a delimiter or a header falls across two chunks. */
function chunked(body: Uint8Array, size: number): ReadableStream<Uint8Array> {
	let offset = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= body.byteLength) {
				controller.close()
				return
			}
			controller.enqueue(body.slice(offset, offset + size))
			offset += size
		},
	})
}

async function all(reader: MultipartReader): Promise<{ name: string; filename: string | null; contentType: string | null; text: string }[]> {
	const parts: { name: string; filename: string | null; contentType: string | null; text: string }[] = []
	for (let part = await reader.next(); part !== null; part = await reader.next()) {
		parts.push({ name: part.name, filename: part.filename, contentType: part.contentType, text: await new Response(part.body).text() })
	}
	return parts
}

/** What a browser's `fetch` sends for a FormData: the encoder Bun shares with every engine. */
async function encoded(form: FormData): Promise<{ readonly boundary: string; readonly bytes: Uint8Array }> {
	const request = new Request('https://example.test/', { method: 'POST', body: form })
	const boundary = multipartBoundary(request.headers.get('Content-Type'))
	if (boundary === null) {
		throw new Error('no boundary')
	}
	return { boundary, bytes: new Uint8Array(await request.arrayBuffer()) }
}

describe('the boundary', () => {
	test('is read from a multipart/form-data Content-Type, quoted or not', () => {
		expect(multipartBoundary('multipart/form-data; boundary=abc123')).toBe('abc123')
		expect(multipartBoundary('Multipart/Form-Data; charset=utf-8; boundary="a b:c"')).toBe('a b:c')
	})

	test('is null for another type, a missing or a malformed boundary', () => {
		expect(multipartBoundary('application/json')).toBeNull()
		expect(multipartBoundary('multipart/form-data')).toBeNull()
		expect(multipartBoundary('multipart/form-data; boundary=')).toBeNull()
		expect(multipartBoundary(`multipart/form-data; boundary=${'x'.repeat(71)}`)).toBeNull()
		expect(multipartBoundary('multipart/form-data; boundary="a"b"')).toBeNull()
		expect(multipartBoundary(null)).toBeNull()
	})
})

describe('the parts', () => {
	test('arrive in order, with their names, file names and types, at any chunk size', async () => {
		const form = new FormData()
		form.append('input', JSON.stringify({ email: 'visitor@example.com' }))
		form.append('photo', new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], 'me.jpg', { type: 'image/jpeg' }))
		const { boundary, bytes } = await encoded(form)
		for (const size of [1, 3, 7, 64, 100_000]) {
			const parts = await all(multipartParts(chunked(bytes, size), boundary, { maxHeaderBytes: 8192 }))
			expect(parts.map(({ name, filename, contentType }) => ({ name, filename, contentType }))).toEqual([
				{ name: 'input', filename: null, contentType: null },
				{ name: 'photo', filename: 'me.jpg', contentType: 'image/jpeg' },
			])
			expect(parts[0]?.text).toBe('{"email":"visitor@example.com"}')
			expect(parts[1]?.text.length).toBe(6)
		}
	})

	test('keep bytes that look like the delimiter but are not it', async () => {
		const boundary = 'b0und'
		const text = `--b0un\r\n--b0unX\r\n--b0un`
		const body = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="input"\r\n\r\n${text}\r\n--${boundary}--\r\n`)
		const parts = await all(multipartParts(chunked(body, 5), boundary, { maxHeaderBytes: 8192 }))
		expect(parts.map((part) => part.text)).toEqual([text])
	})

	test('a part read before the previous one ended is refused', async () => {
		const form = new FormData()
		form.append('input', '{}')
		form.append('photo', new File(['x'], 'a.txt', { type: 'text/plain' }))
		const { boundary, bytes } = await encoded(form)
		const reader = multipartParts(chunked(bytes, 4), boundary, { maxHeaderBytes: 8192 })
		await reader.next()
		expect(reader.next()).rejects.toBeInstanceOf(MultipartError)
	})

	test('after a cancelled body there is no further part to tell from a missing one', async () => {
		const form = new FormData()
		form.append('input', '{}')
		form.append('photo', new File(['x'], 'a.txt', { type: 'text/plain' }))
		const { boundary, bytes } = await encoded(form)
		const reader = multipartParts(chunked(bytes, 4), boundary, { maxHeaderBytes: 8192 })
		const first = await reader.next()
		await first?.body.cancel()
		expect(reader.next()).rejects.toThrow('the body was not read to its end')
	})
})

describe('a malformed body is refused', () => {
	const boundary = 'xyz'
	const refused = async (raw: string, maxHeaderBytes = 8192): Promise<string> => {
		const reader = multipartParts(chunked(encoder.encode(raw), 3), boundary, { maxHeaderBytes })
		try {
			await all(reader)
		} catch (error) {
			expect(error).toBeInstanceOf(MultipartError)
			expect(reader.failure()).not.toBeNull()
			return error instanceof Error ? error.message : String(error)
		}
		throw new Error('the body was accepted')
	}

	test('with a preamble, or another boundary', async () => {
		expect(await refused(`hello\r\n--xyz\r\nContent-Disposition: form-data; name="input"\r\n\r\n{}\r\n--xyz--`)).toBe(
			'the body does not start with its boundary',
		)
		expect(await refused(`--abc\r\nContent-Disposition: form-data; name="input"\r\n\r\n{}\r\n--abc--`)).toBe(
			'the body does not start with its boundary',
		)
	})

	test('that ends inside a part, its headers or a delimiter', async () => {
		expect(await refused(`--xyz\r\nContent-Disposition: form-data; name="input"\r\n\r\n{}`)).toBe('the body ends inside a part')
		expect(await refused(`--xyz\r\nContent-Disposition: form-data; name="in`)).toBe("the body ends inside a part's headers")
		expect(await refused(`--xyz`)).toBe('the body ends inside a delimiter')
	})

	test('with a part that is no form-data, has no name, or two names', async () => {
		expect(await refused(`--xyz\r\nContent-Type: text/plain\r\n\r\nx\r\n--xyz--`)).toStartWith('a part is not form-data')
		expect(await refused(`--xyz\r\nContent-Disposition: form-data\r\n\r\nx\r\n--xyz--`)).toBe('a part has no name')
		expect(await refused(`--xyz\r\nContent-Disposition: form-data; name="a"; name="b"\r\n\r\nx\r\n--xyz--`)).toBe(
			"a part's name is malformed or given twice",
		)
		expect(await refused(`--xyz\r\nnonsense\r\n\r\nx\r\n--xyz--`)).toBe('a part header is not a name and a value')
	})

	test('with headers past their bound, or garbage after a delimiter', async () => {
		expect(await refused(`--xyz\r\nContent-Disposition: form-data; name="${'a'.repeat(200)}"\r\n\r\nx\r\n--xyz--`, 64)).toBe(
			"a part's headers are longer than 64 bytes",
		)
		expect(await refused(`--xyzJUNK`)).toBe('a delimiter is followed by neither CRLF nor --')
	})
})
