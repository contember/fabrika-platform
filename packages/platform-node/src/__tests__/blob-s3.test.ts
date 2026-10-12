// The blob store against a real S3-compatible endpoint (SeaweedFS in CI/locally; R2 works unchanged).
// The port's contract is small, and the one bit that is easy to get wrong is `get()` returning NULL
// for a missing key rather than throwing — every call site branches on that.

import { afterAll, describe, expect, test } from 'bun:test'
import { S3BlobStore } from '../blob-s3'
import { hasS3, s3Options, skipReason } from './helpers/s3'

if (!hasS3) {
	console.warn(`blob-s3.test.ts ${skipReason}`)
}

const store = s3Options === null ? null : S3BlobStore.connect(s3Options)
const written: string[] = []

/** A unique key per test, so a shared bucket never makes two runs collide. */
function key(name: string): string {
	const value = `platform-node-tests/${Date.now()}-${Math.random().toString(36).slice(2, 8)}/${name}`
	written.push(value)
	return value
}

afterAll(async () => {
	for (const value of written) {
		await store?.delete(value).catch(() => {})
	}
})

describe.skipIf(!hasS3)('S3BlobStore', () => {
	test('round-trips a string', async () => {
		const path = key('logs.ndjson')
		await store?.put(path, '{"line":1}\n{"line":2}\n')
		const object = await store?.get(path)
		expect(object).not.toBeNull()
		expect(await object?.text()).toBe('{"line":1}\n{"line":2}\n')
	})

	test('round-trips bytes', async () => {
		const path = key('bytes.bin')
		await store?.put(path, new Uint8Array([1, 2, 3, 250]).buffer)
		const object = await store?.get(path)
		const bytes = new Uint8Array(await new Response(object?.body).arrayBuffer())
		expect([...bytes]).toEqual([1, 2, 3, 250])
	})

	test('round-trips a ReadableStream without buffering it first', async () => {
		const path = key('streamed.txt')
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('chunk one '))
				controller.enqueue(new TextEncoder().encode('chunk two'))
				controller.close()
			},
		})
		await store?.put(path, stream)
		expect(await (await store?.get(path))?.text()).toBe('chunk one chunk two')
	})

	test('get() returns NULL for a missing key rather than throwing', async () => {
		expect(await store?.get(key('definitely-not-here.txt'))).toBeNull()
	})

	test('body is one stream, read once', async () => {
		const path = key('once.txt')
		await store?.put(path, 'hello')
		const object = await store?.get(path)
		const first = object?.body
		const second = object?.body
		expect(first).toBe(second)
		expect(await new Response(first).text()).toBe('hello')
	})

	test('put overwrites an existing key', async () => {
		const path = key('overwrite.txt')
		await store?.put(path, 'v1')
		await store?.put(path, 'v2')
		expect(await (await store?.get(path))?.text()).toBe('v2')
	})

	test('delete removes the object and is idempotent', async () => {
		const path = key('gone.txt')
		await store?.put(path, 'bye')
		await store?.delete(path)
		expect(await store?.get(path)).toBeNull()
		await store?.delete(path)
	})

	test('a key with slashes and unusual characters round-trips', async () => {
		const path = key('runs/2026-07-28/run id (1)/logs.ndjson')
		await store?.put(path, 'nested')
		expect(await (await store?.get(path))?.text()).toBe('nested')
	})
})

/** A body of `total` zero bytes in 64 KiB chunks, counting what the reader pulled. */
function countedBody(total: number): { readonly body: ReadableStream<Uint8Array>; pulled(): number } {
	let pulled = 0
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulled >= total) {
				controller.close()
				return
			}
			pulled += 65536
			controller.enqueue(new Uint8Array(65536))
		},
	})
	return { body, pulled: () => pulled }
}

describe.skipIf(!hasS3)('S3BlobStore as a FileObjectStore', () => {
	test('writes a stream with its content type and reads both back with the size', async () => {
		const path = key('image.png')
		const written = await store?.write(path, new Blob([new Uint8Array([137, 80, 78, 71])]).stream(), { contentType: 'image/png', maxBytes: 10 })
		expect(written).toEqual({ size: 4, contentType: 'image/png' })
		const object = await store?.read(path)
		expect(object?.size).toBe(4)
		expect(object?.contentType).toBe('image/png')
		expect([...new Uint8Array(await new Response(object?.body).arrayBuffer())]).toEqual([137, 80, 78, 71])
	})

	test('a body over maxBytes stops while streaming and leaves nothing stored', async () => {
		const path = key('too-large.bin')
		const source = countedBody(64 * 1024 * 1024)
		const failure = await store?.write(path, source.body, { contentType: 'application/pdf', maxBytes: 1024 * 1024 }).then(() => null, (error) => error)
		expect(failure).toBeInstanceOf(Error)
		expect(failure instanceof Error ? failure.name : '').toBe('ObjectTooLargeError')
		// The upload read about the limit, not the whole body.
		expect(source.pulled()).toBeLessThan(4 * 1024 * 1024)
		expect(await store?.read(path)).toBeNull()
	})

	test('a body of exactly maxBytes is stored', async () => {
		const path = key('exact.bin')
		expect(await store?.write(path, countedBody(65536 * 2).body, { contentType: 'application/pdf', maxBytes: 65536 * 2 })).toEqual({
			size: 65536 * 2,
			contentType: 'application/pdf',
		})
	})

	test('read() returns NULL for a missing key', async () => {
		expect(await store?.read(key('missing.bin'))).toBeNull()
	})

	test('a key is written once, and a read is bound to the version it returned', async () => {
		const path = key('once.txt')
		const bytes = (text: string) => new Blob([text]).stream()
		await store?.write(path, bytes('first'), { contentType: 'text/plain', maxBytes: 100 })
		const failure = await store?.write(path, bytes('second'), { contentType: 'text/plain', maxBytes: 100 }).then(() => null, (error) => error)
		expect(failure instanceof Error ? failure.name : '').toBe('ObjectExistsError')
		const first = await store?.read(path)
		expect(await new Response(first?.body).text()).toBe('first')
		const version = first?.version ?? ''
		expect(version).not.toBe('')
		expect(await new Response((await store?.readVersion(path, version))?.body).text()).toBe('first')
		// A write outside the upload path replaces it: the version it was read as no longer reads.
		await store?.put(path, 'other')
		expect(await store?.readVersion(path, version)).toBeNull()
		expect((await store?.read(path))?.version).not.toBe(version)
	})
})
