// Reading a body with a byte budget. A body over the budget, or one whose reader the deadline cancels, is never
// buffered whole: the stream is cancelled and nothing of it is kept.

export interface BoundedRead {
	readonly maxBytes: number
	/** `Content-Length`, when the sender declared one: a larger value is refused before anything is read. */
	readonly declaredLength?: string | null
	/** Aborting it cancels the stream; the read then rejects. */
	readonly signal?: AbortSignal
}

/** The body's bytes, or `null` when it is larger than `maxBytes`. Rejects when `signal` aborts the read. */
export async function readBoundedBytes(stream: ReadableStream<Uint8Array> | null, options: BoundedRead): Promise<Uint8Array<ArrayBuffer> | null> {
	const declared = Number(options.declaredLength ?? '')
	if (options.declaredLength !== undefined && options.declaredLength !== null && Number.isFinite(declared) && declared > options.maxBytes) {
		await stream?.cancel()
		return null
	}
	const reader = stream?.getReader()
	if (reader === undefined) {
		return new Uint8Array()
	}
	const { signal } = options
	const aborted = (): boolean => signal?.aborted === true
	const cancel = () => {
		reader.cancel().catch(() => {})
	}
	signal?.addEventListener('abort', cancel, { once: true })
	try {
		const chunks: Uint8Array[] = []
		let size = 0
		for (;;) {
			if (aborted()) {
				throw new Error('the read was aborted')
			}
			const { done, value } = await reader.read()
			if (aborted()) {
				throw new Error('the read was aborted')
			}
			if (done) {
				break
			}
			size += value.byteLength
			if (size > options.maxBytes) {
				await reader.cancel()
				return null
			}
			chunks.push(value)
		}
		const body = new Uint8Array(size)
		let offset = 0
		for (const chunk of chunks) {
			body.set(chunk, offset)
			offset += chunk.byteLength
		}
		return body
	} finally {
		signal?.removeEventListener('abort', cancel)
	}
}
