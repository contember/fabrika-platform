// The byte streams of a stored file on its way in and out: the head the sniff reads, the digest and the deadline of a
// write, the exact read of a file a site opens, and the client's file name as metadata.

import { createHash } from 'node:crypto'

const MAX_NAME_CODE_POINTS = 255

/** The client's file name, metadata only: at most 255 code points, never half a character, no control characters. */
export function cleanName(raw: string): string | null {
	const name = Array.from(raw.replace(/\p{Cc}/gu, '').trim()).slice(0, MAX_NAME_CODE_POINTS).join('')
	return name === '' ? null : name
}

/** The first `size` bytes of `body`, and a stream that yields the whole body again. */
export async function readHead(
	body: ReadableStream<Uint8Array>,
	size: number,
): Promise<{ readonly head: Uint8Array; readonly stream: ReadableStream<Uint8Array> }> {
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	let done = false
	while (length < size) {
		const next = await reader.read()
		if (next.done) {
			done = true
			break
		}
		chunks.push(next.value)
		length += next.value.byteLength
	}
	const buffered = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		buffered.set(chunk, offset)
		offset += chunk.byteLength
	}
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			if (buffered.byteLength > 0) {
				controller.enqueue(buffered)
			}
			if (done) {
				controller.close()
			}
		},
		async pull(controller) {
			const next = await reader.read()
			if (next.done) {
				controller.close()
			} else {
				controller.enqueue(next.value)
			}
		},
		cancel: (reason) => reader.cancel(reason),
	})
	return { head: buffered.subarray(0, size), stream }
}

/** The body as it is stored: hashed on the way, and failed once `timeoutMs` (`null`: no timer) passes before it ends. */
export function digesting(body: ReadableStream<Uint8Array>, timeoutMs: number | null): {
	readonly stream: ReadableStream<Uint8Array>
	digest(): string
	timedOut(): boolean
	stop(): void
} {
	const hasher = createHash('sha256')
	let timer: ReturnType<typeof setTimeout> | undefined
	let expired = false
	const stream = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			start(controller) {
				if (timeoutMs !== null) {
					timer = setTimeout(() => {
						expired = true
						controller.error(new Error('the upload did not finish in time'))
					}, timeoutMs)
				}
			},
			transform(chunk, controller) {
				hasher.update(chunk)
				controller.enqueue(chunk)
			},
			flush() {
				clearTimeout(timer)
			},
		}),
	)
	return { stream, digest: () => hasher.digest('hex'), timedOut: () => expired, stop: () => clearTimeout(timer) }
}

/** The whole body when it holds exactly `size` bytes; `null` as soon as it proves longer, or once it ends shorter. */
export async function readExactly(body: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array | null> {
	const bytes = new Uint8Array(size)
	let length = 0
	const reader = body.getReader()
	try {
		for (let next = await reader.read(); !next.done; next = await reader.read()) {
			if (length + next.value.byteLength > size) {
				return null
			}
			bytes.set(next.value, length)
			length += next.value.byteLength
		}
	} finally {
		reader.releaseLock()
	}
	return length === size ? bytes : null
}

export function isNamed(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name
}
