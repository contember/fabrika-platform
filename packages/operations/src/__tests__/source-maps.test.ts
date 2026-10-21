import type { StackFrame } from '@fabrika/operations-contract'
import { describe, expect, test } from 'bun:test'
import type { ObjectReader } from '../source-maps.js'
import { MAX_RESOLVED_FRAMES_PER_EVENT, MAX_SOURCE_MAPS_PER_EVENT, resolveFrames, SOURCE_MAP_LOAD_CONCURRENCY } from '../source-maps.js'

const MAP = JSON.stringify({
	version: 3,
	sources: ['src/app.ts'],
	names: [],
	mappings: 'AAAA',
	sourcesContent: ['throw new Error()'],
})

interface CountingReader extends ObjectReader {
	readonly loads: string[]
	readonly parses: () => number
	readonly maxInFlight: () => number
}

function countingReader(): CountingReader {
	const loads: string[] = []
	let parses = 0
	let inFlight = 0
	let maxInFlight = 0
	return {
		loads,
		parses: () => parses,
		maxInFlight: () => maxInFlight,
		async get() {
			return null
		},
		async getSourceMap(_sourceId, _releaseName, logicalPath) {
			loads.push(logicalPath)
			inFlight++
			maxInFlight = Math.max(maxInFlight, inFlight)
			await Bun.sleep(1)
			inFlight--
			return {
				async text() {
					parses++
					return MAP
				},
			}
		},
	}
}

function frame(file: string, inApp?: boolean): StackFrame {
	return { absPath: `https://app.test/assets/${file}`, line: 1, column: 1, ...(inApp === undefined ? {} : { inApp }) }
}

describe('source-map resolution limits', () => {
	test('loads and parses one map once however many frames name it', async () => {
		const reader = countingReader()
		const frames = Array.from({ length: 50 }, () => frame('index.js'))
		const resolved = await resolveFrames(frames, 'source-a', 'v1', reader)
		expect(resolved.every((display) => display.resolved)).toBeTrue()
		expect(reader.loads).toEqual(['assets/index.js'])
		expect(reader.parses()).toBe(1)
	})

	test('resolves at most the frame cap, from the top of the stack', async () => {
		const reader = countingReader()
		const count = MAX_RESOLVED_FRAMES_PER_EVENT + 50
		const frames = Array.from({ length: count }, () => frame('index.js'))
		const resolved = await resolveFrames(frames, 'source-a', 'v1', reader)
		expect(resolved).toHaveLength(count)
		expect(resolved.slice(0, 50).some((display) => display.resolved)).toBeFalse()
		expect(resolved.slice(50).every((display) => display.resolved)).toBeTrue()
	})

	test('spends the frame cap on in-app frames first', async () => {
		const reader = countingReader()
		const count = MAX_RESOLVED_FRAMES_PER_EVENT + 50
		const frames = Array.from({ length: count }, (_, index) => frame('index.js', index < 10))
		const resolved = await resolveFrames(frames, 'source-a', 'v1', reader)
		expect(resolved.slice(0, 10).every((display) => display.resolved)).toBeTrue()
		expect(resolved.filter((display) => display.resolved)).toHaveLength(MAX_RESOLVED_FRAMES_PER_EVENT)
		expect(resolved.slice(10, 50).some((display) => display.resolved)).toBeFalse()
	})

	test('never fetches more distinct maps than the cap and bounds concurrent loads', async () => {
		const reader = countingReader()
		const frames = Array.from({ length: MAX_SOURCE_MAPS_PER_EVENT + 4 }, (_, index) => frame(`chunk-${index}.js`))
		const resolved = await resolveFrames(frames, 'source-a', 'v1', reader)
		expect(reader.loads).toHaveLength(MAX_SOURCE_MAPS_PER_EVENT)
		expect(reader.loads).not.toContain('assets/chunk-0.js')
		expect(resolved.slice(0, 4).some((display) => display.resolved)).toBeFalse()
		expect(resolved.slice(4).every((display) => display.resolved)).toBeTrue()
		expect(reader.maxInFlight()).toBeLessThanOrEqual(SOURCE_MAP_LOAD_CONCURRENCY)
	})
})
