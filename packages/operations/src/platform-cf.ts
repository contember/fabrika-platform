import { decodeSignInSignals } from '@fabrika/auth'
import type { IamSignInSignalsRpc } from '@fabrika/auth-core'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import type { OperationsMaintenance } from './maintenance.js'

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

export interface CloudflareScheduledContextLike {
	waitUntil(promise: Promise<unknown>): void
}

export function runCloudflareScheduledMaintenance(
	maintenance: OperationsMaintenance,
	context: CloudflareScheduledContextLike,
): void {
	context.waitUntil(maintenance.run())
}

const BINDING_TIMEOUT_MS = 5_000

/**
 * IAM's sign-in signals over the `IAM` service binding to its full entrypoint, every answer decoded as the HTTP
 * transport decodes it. Read, never tested with `in`: a binding stub answers any name and an older IAM rejects the call.
 */
export function bindingSignInSignals(binding: unknown): IamSignInSignalsRpc | undefined {
	if (typeof binding !== 'object' || binding === null) return undefined
	return {
		async signInSignals(input) {
			const call: unknown = Reflect.get(binding, 'signInSignals')
			if (typeof call !== 'function') throw new Error('the IAM binding has no signInSignals')
			// The HTTP transport's bound: a hung IAM must not hold the minute pass.
			let timer: ReturnType<typeof setTimeout> | undefined
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('the IAM binding did not answer signInSignals in time')), BINDING_TIMEOUT_MS)
			})
			try {
				return decodeSignInSignals(await Promise.race([Reflect.apply(call, binding, [input]), timeout]))
			} finally {
				clearTimeout(timer)
			}
		},
	}
}
