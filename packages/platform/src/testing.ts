import type { BlobStore, JobQueue } from './ports'
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
