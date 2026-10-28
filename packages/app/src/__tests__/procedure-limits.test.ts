// A procedure's limits: its body deadline follows from `maxBytes` (30 s at least, else the body at 16 KiB/s), a body
// that stalls past it is the sender's 408, and a body past `maxBytes` is a 413, before the handler runs.

import { describe, expect, test } from 'bun:test'
import { bodyDeadlineMs } from '../contract/defaults'
import { HttpError } from '../errors'
import { readBoundedBody } from '../implement/anonymous'

/** A request whose body sends one chunk and then waits for good. */
function stalled(): Request {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"name":'))
		},
	})
	return new Request('https://app.example/api/x', { method: 'POST', body })
}

describe('the body deadline of a procedure', () => {
	test('is 30 s for a JSON body, and the body at 16 KiB/s for a large one', () => {
		expect(bodyDeadlineMs(64 * 1024)).toBe(30_000)
		expect(bodyDeadlineMs(1024 * 1024)).toBe(64_000)
		// "a 10 MiB body gets about 11 min"
		expect(bodyDeadlineMs(10 * 1024 * 1024)).toBe(640_000)
	})

	test('a body that stalls past it is a 408', async () => {
		const deadline = new AbortController()
		const read = readBoundedBody(stalled(), 1024, deadline.signal)
		deadline.abort()
		const error = await read.then(() => null, (refusal: unknown) => refusal)
		expect(error).toBeInstanceOf(HttpError)
		expect(error instanceof HttpError ? error.httpStatus : null).toBe(408)
	})

	test('a body past maxBytes is a 413', async () => {
		const request = new Request('https://app.example/api/x', { method: 'POST', body: 'x'.repeat(2048) })
		const error = await readBoundedBody(request, 1024).then(() => null, (refusal: unknown) => refusal)
		expect(error instanceof HttpError ? error.httpStatus : null).toBe(413)
	})
})
