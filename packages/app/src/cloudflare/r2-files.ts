// The stored files of an application environment in its R2 bucket (`FABRIKA_FILES`, ADR-0065 §6): the
// `FileObjectStore` port, as the S3 store serves it on Zerops. A version is the object's etag.

import { type FileObjectStore, ObjectExistsError, type ObjectMetadata, ObjectTooLargeError, type StoredObject } from '@fabrika/platform'
import { method } from './bindings.js'

/**
 * R2 stores a stream only when its length is known up front, which an upload's is not. A body up to this size is
 * buffered and written in one conditional put; a longer one goes up in parts of this size, so an object holds at most
 * one part in memory. R2 takes parts of at least 5 MiB, all but the last of one size.
 */
export const R2_PART_BYTES = 8 * 1024 * 1024

interface R2Info {
	readonly size: number
	readonly etag: string
	readonly contentType: string | null
	readonly body: ReadableStream<Uint8Array> | null
}

/** An R2 answer's object, or `null` for anything else. */
function infoOf(value: unknown): R2Info | null {
	if (typeof value !== 'object' || value === null) {
		return null
	}
	const size: unknown = Reflect.get(value, 'size')
	const etag: unknown = Reflect.get(value, 'etag')
	if (typeof size !== 'number' || !Number.isSafeInteger(size) || typeof etag !== 'string' || etag === '') {
		return null
	}
	const metadata: unknown = Reflect.get(value, 'httpMetadata')
	const type: unknown = typeof metadata === 'object' && metadata !== null ? Reflect.get(metadata, 'contentType') : undefined
	const body: unknown = 'body' in value ? Reflect.get(value, 'body') : null
	return { size, etag, contentType: typeof type === 'string' && type !== '' ? type : null, body: body instanceof ReadableStream ? body : null }
}

function required(binding: unknown, name: string): (...args: unknown[]) => unknown {
	const found = method(binding, name)
	if (found === null) {
		throw new Error(`the FABRIKA_FILES binding has no ${name}; it is an R2 bucket`)
	}
	return found
}

function joined(chunks: readonly Uint8Array[], length: number): Uint8Array {
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

interface MultipartUpload {
	uploadPart(bytes: Uint8Array): Promise<void>
	complete(): Promise<void>
	abort(): Promise<void>
}

async function multipartUpload(bucket: unknown, key: string, contentType: string): Promise<MultipartUpload> {
	const upload: unknown = await required(bucket, 'createMultipartUpload')(key, { httpMetadata: { contentType } })
	const parts: { readonly partNumber: number; readonly etag: string }[] = []
	return {
		async uploadPart(bytes) {
			const partNumber = parts.length + 1
			const uploaded: unknown = await required(upload, 'uploadPart')(partNumber, bytes)
			const etag: unknown = typeof uploaded === 'object' && uploaded !== null ? Reflect.get(uploaded, 'etag') : undefined
			if (typeof etag !== 'string') {
				throw new Error('R2 answered a part upload without its etag')
			}
			parts.push({ partNumber, etag })
		},
		async complete() {
			await required(upload, 'complete')(parts)
		},
		async abort() {
			await required(upload, 'abort')()
		},
	}
}

/** `bucket` (an R2 binding) as the files' object store, or `undefined` when the environment binds none. */
export function r2FileObjectStore(bucket: unknown): FileObjectStore | undefined {
	if (!['head', 'get', 'put', 'delete'].every((name) => method(bucket, name) !== null)) {
		return undefined
	}
	const head = required(bucket, 'head')
	const get = required(bucket, 'get')
	const put = required(bucket, 'put')
	const remove = required(bucket, 'delete')

	const stored = (answer: unknown): StoredObject | null => {
		const info = infoOf(answer)
		// An object without a body is R2's answer to a failed condition: the object was replaced.
		if (info === null || info.body === null) {
			return null
		}
		return { size: info.size, contentType: info.contentType, version: info.etag, body: info.body }
	}
	const stopped = (signal: AbortSignal | undefined): void => {
		if (signal?.aborted === true) {
			throw new Error('the object read was stopped')
		}
	}

	return {
		async write(key, body, options): Promise<ObjectMetadata> {
			// A file's key is a fresh UUID behind a unique row; the conditional put refuses a reused key atomically, and
			// this check refuses one before a multipart upload, which takes no condition.
			if ((await head(key)) !== null) {
				await body.cancel()
				throw new ObjectExistsError()
			}
			const httpMetadata = { contentType: options.contentType }
			const reader = body.getReader()
			const pending: Uint8Array[] = []
			let buffered = 0
			let size = 0
			let upload: MultipartUpload | null = null
			try {
				for (;;) {
					const { done, value } = await reader.read()
					if (done) {
						break
					}
					size += value.byteLength
					if (size > options.maxBytes) {
						await reader.cancel()
						throw new ObjectTooLargeError(options.maxBytes)
					}
					pending.push(value)
					buffered += value.byteLength
					while (buffered >= R2_PART_BYTES) {
						const all = joined(pending, buffered)
						pending.length = 0
						pending.push(all.subarray(R2_PART_BYTES))
						buffered -= R2_PART_BYTES
						upload ??= await multipartUpload(bucket, key, options.contentType)
						await upload.uploadPart(all.subarray(0, R2_PART_BYTES))
					}
				}
				const rest = joined(pending, buffered)
				if (upload === null) {
					if ((await put(key, rest, { httpMetadata, onlyIf: { etagDoesNotMatch: '*' } })) === null) {
						throw new ObjectExistsError()
					}
				} else {
					if (rest.byteLength > 0) {
						await upload.uploadPart(rest)
					}
					await upload.complete()
				}
			} catch (error) {
				await upload?.abort().catch(() => undefined)
				throw error
			}
			return { size, contentType: options.contentType }
		},
		async read(key, signal) {
			stopped(signal)
			return stored(await get(key))
		},
		async readVersion(key, version, signal) {
			stopped(signal)
			return stored(await get(key, { onlyIf: { etagMatches: version } }))
		},
		async delete(key) {
			await remove(key)
		},
	}
}
