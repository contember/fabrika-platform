import { describe, expect, test } from 'bun:test'
import { pullThrough } from '../streams'

/** A source that yields `chunks` one per pull, then fails or ends, and records its cancellation. */
function source(chunks: readonly string[], failure?: Error) {
	let index = 0
	const cancelled: unknown[] = []
	const stream = new ReadableStream<string>({
		pull(controller) {
			const next = chunks[index++]
			if (next !== undefined) controller.enqueue(next)
			else if (failure !== undefined) controller.error(failure)
			else controller.close()
		},
		cancel(reason) {
			cancelled.push(reason)
		},
	}, { highWaterMark: 0 })
	return { stream, cancelled, pulled: () => index }
}

function upper(): TransformStream<string, string> {
	return new TransformStream({ transform: (chunk, controller) => controller.enqueue(chunk.toUpperCase()) })
}

describe('pullThrough', () => {
	test('passes the source through the transform in order', async () => {
		const input = source(['a', 'b', 'c'])
		const output: string[] = []
		const reader = pullThrough(input.stream, upper()).getReader()
		for (let result = await reader.read(); !result.done; result = await reader.read()) output.push(result.value)
		expect(output).toEqual(['A', 'B', 'C'])
	})

	test('a source error reaches the consumer', async () => {
		const failure = new Error('download broke')
		const reader = pullThrough(source(['a'], failure).stream, upper()).getReader()
		expect(await reader.read()).toEqual({ done: false, value: 'A' })
		await expect(reader.read()).rejects.toBe(failure)
	})

	test('a transform error reaches the consumer and cancels the source', async () => {
		const failure = new Error('corrupt gzip')
		const input = source(['a', 'b', 'c'])
		const failing = new TransformStream<string, string>({
			transform: (chunk, controller) => {
				if (chunk === 'b') throw failure
				controller.enqueue(chunk)
			},
		})
		const reader = pullThrough(input.stream, failing).getReader()
		expect(await reader.read()).toEqual({ done: false, value: 'a' })
		await expect(reader.read()).rejects.toBe(failure)
		expect(input.cancelled).toEqual([failure])
		expect(input.pulled()).toBe(2)
	})

	test('a downstream cancel cancels the source without reading further', async () => {
		const input = source(['a', 'b', 'c'])
		const reader = pullThrough(input.stream, upper()).getReader()
		expect(await reader.read()).toEqual({ done: false, value: 'A' })
		await reader.cancel('destination gone')
		expect(input.cancelled).toEqual(['destination gone'])
		expect(input.pulled()).toBe(1)
	})
})
