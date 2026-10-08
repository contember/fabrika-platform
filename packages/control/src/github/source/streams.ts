/**
 * Run `source` through `transform`, reading input only while the consumer waits for output.
 * Bun's `CompressionStream`/`DecompressionStream` report no backpressure, so `pipeThrough` would pull a
 * whole repository into memory; this keeps each stage at about one chunk (`streaming.test.ts`).
 */
export function pullThrough<I, O>(source: ReadableStream<I>, transform: TransformStream<I, O>): ReadableStream<O> {
	const input = source.getReader()
	const writer = transform.writable.getWriter()
	const output = transform.readable.getReader()
	let inputDone = false
	let lastWrite: Promise<void> = Promise.resolve()
	return new ReadableStream<O>({
		async pull(controller) {
			const next = output.read()
			let ready = false
			next.then(() => (ready = true), () => (ready = true))
			try {
				while (!ready && !inputDone) {
					// A write settles once the transform accepts the chunk, which may wait for this very read.
					await Promise.race([lastWrite, next])
					if (ready) break
					const chunk = await input.read()
					if (chunk.done) {
						inputDone = true
						// Closing settles only once all output is read, so its outcome arrives through `next`.
						writer.close().catch(() => {})
						break
					}
					lastWrite = writer.write(chunk.value)
					lastWrite.catch(() => {})
					await Promise.race([lastWrite, next])
				}
				const result = await next
				if (result.done) controller.close()
				else controller.enqueue(result.value)
			} catch (error) {
				await Promise.allSettled([writer.abort(error), input.cancel(error)])
				throw error
			}
		},
		async cancel(reason) {
			await Promise.allSettled([input.cancel(reason), writer.abort(reason)])
		},
	}, { highWaterMark: 0 })
}
