import {
	type BlobStore,
	type FileObjectStore,
	type JobQueue,
	type ObjectMetadata,
	ObjectTooLargeError,
	type ObjectWriteOptions,
	type StoredObject,
} from './ports'
import type { SqlDatabase } from './sql'

/** A blob store that keeps string values in memory. */
export class MemoryBlobs implements BlobStore {
	readonly values = new Map<string, string>()

	put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void> {
		if (typeof value !== 'string') throw new Error('test blob store accepts strings only')
		this.values.set(key, value)
		return Promise.resolve()
	}

	get(key: string): Promise<{ body: ReadableStream; text(): Promise<string> } | null> {
		const value = this.values.get(key)
		if (value === undefined) return Promise.resolve(null)
		return Promise.resolve({ body: new Blob([value]).stream(), text: () => Promise.resolve(value) })
	}

	delete(key: string): Promise<void> {
		this.values.delete(key)
		return Promise.resolve()
	}
}

/** A file object store in memory, with the port's size bound enforced while the body streams. */
export class MemoryFileObjects implements FileObjectStore {
	readonly objects = new Map<string, { readonly bytes: Uint8Array<ArrayBuffer>; readonly contentType: string }>()

	async write(key: string, body: ReadableStream<Uint8Array>, options: ObjectWriteOptions): Promise<ObjectMetadata> {
		const reader = body.getReader()
		const chunks: Uint8Array[] = []
		let size = 0
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			size += next.value.byteLength
			if (size > options.maxBytes) {
				await reader.cancel()
				throw new ObjectTooLargeError(options.maxBytes)
			}
			chunks.push(next.value)
		}
		const bytes = new Uint8Array(size)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		this.objects.set(key, { bytes, contentType: options.contentType })
		return { size, contentType: options.contentType }
	}

	read(key: string): Promise<StoredObject | null> {
		const object = this.objects.get(key)
		if (object === undefined) return Promise.resolve(null)
		return Promise.resolve({ size: object.bytes.byteLength, contentType: object.contentType, body: new Blob([object.bytes]).stream() })
	}

	delete(key: string): Promise<void> {
		this.objects.delete(key)
		return Promise.resolve()
	}
}

/** A queue that records every sent message. */
export class MemoryQueue<T> implements JobQueue<T> {
	readonly messages: T[] = []

	send(message: T): Promise<void> {
		this.messages.push(message)
		return Promise.resolve()
	}
}

/** A queue that accepts and discards every message. */
export class EmptyQueue<T> implements JobQueue<T> {
	send(): Promise<void> {
		return Promise.resolve()
	}
}

/** A database for code paths that must not query it. */
export const unusedDatabase: SqlDatabase = {
	prepare() {
		throw new Error('database access was not expected')
	},
	batch() {
		return Promise.reject(new Error('database access was not expected'))
	},
}
