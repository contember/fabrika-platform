// The blob store against a real S3-compatible endpoint (MinIO in CI/locally; R2 works unchanged).
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
