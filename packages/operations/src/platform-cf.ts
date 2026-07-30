import type { BlobStore, JobQueue } from '@fabrika/platform'

export interface CloudflareBucketLike {
	put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<unknown>
	get(key: string): Promise<{ body: ReadableStream; text(): Promise<string> } | null>
	delete(key: string): Promise<unknown>
}

export interface CloudflareQueueLike<T> {
	send(message: T, options?: { delaySeconds?: number }): Promise<unknown>
}

export function cloudflareBlobStore(bucket: CloudflareBucketLike): BlobStore {
	return {
		async put(key, value) {
			await bucket.put(key, value)
		},
		get(key) {
			return bucket.get(key)
		},
		async delete(key) {
			await bucket.delete(key)
		},
	}
}

export function cloudflareJobQueue<T>(queue: CloudflareQueueLike<T>): JobQueue<T> {
	return {
		async send(message, options) {
			await queue.send(message, options)
		},
	}
}
