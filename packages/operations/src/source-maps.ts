import type { DisplayFrame, SourceContext, StackFrame } from '@fabrika/operations-contract'
import { SourceMapConsumer } from 'source-map-js'
import type { RawSourceMap } from 'source-map-js'
import { z } from 'zod'

export interface ObjectReader {
	get(key: string): Promise<{ text(): Promise<string> } | null>
	getSourceMap?(sourceId: string, releaseName: string, logicalPath: string): Promise<{ text(): Promise<string> } | null>
}

const CONTEXT_RADIUS = 5
// A stack within the 120 KiB ingest cap can carry thousands of frames; bound the work one detail view does.
export const MAX_RESOLVED_FRAMES_PER_EVENT = 250
// Each distinct map is a fetch, a JSON parse and a consumer build of up to megabytes.
export const MAX_SOURCE_MAPS_PER_EVENT = 16
// Measured worst case without it: 16 dense 8 MiB maps took ~17 s of synchronous parsing and 3.8 GB on Bun.
export const MAX_SOURCE_MAP_TEXT_PER_EVENT = 16 * 1024 * 1024
// Bounds how many map bodies are fetched and held in memory at the same time.
export const SOURCE_MAP_LOAD_CONCURRENCY = 4

const rawSourceMapSchema = z.object({
	version: z.union([z.string(), z.number()]).transform(String),
	sources: z.array(z.string()),
	names: z.array(z.string()),
	mappings: z.string(),
	file: z.string().optional().catch(undefined),
	sourceRoot: z.string().optional().catch(undefined),
	sourcesContent: z.array(z.string()).optional(),
})

function parseRawSourceMap(value: unknown): RawSourceMap | null {
	const result = rawSourceMapSchema.safeParse(value)
	return result.success ? result.data : null
}

export function frameBasename(fileReference: string): string {
	let file = fileReference
	const query = file.indexOf('?')
	if (query !== -1) file = file.slice(0, query)
	const hash = file.indexOf('#')
	if (hash !== -1) file = file.slice(0, hash)
	const slash = file.lastIndexOf('/')
	return slash === -1 ? file : file.slice(slash + 1)
}

export function logicalAssetPath(fileReference: string): string {
	let path = fileReference
	try {
		const url = new URL(fileReference)
		path = url.pathname
	} catch {
		const query = path.indexOf('?')
		if (query !== -1) path = path.slice(0, query)
		const hash = path.indexOf('#')
		if (hash !== -1) path = path.slice(0, hash)
	}
	path = path.replaceAll('\\', '/').replace(/^~?\//, '')
	const parts = path.split('/').filter((part) => part !== '' && part !== '.')
	if (parts.length === 0 || parts.some((part) => part === '..')) {
		throw new Error('invalid logical asset path')
	}
	const normalized = parts.join('/')
	if (normalized.length > 2_048) throw new Error('logical asset path is too long')
	return normalized
}

export function sourceMapKey(sourceId: string, release: string, file: string): string {
	return `source-maps/index/${encodeURIComponent(sourceId)}/${encodeURIComponent(release)}/${encodeURIComponent(logicalAssetPath(file))}.json`
}

function frameFile(frame: StackFrame): string {
	return frame.absPath ?? frame.filename ?? ''
}

function rawSourceContext(frame: StackFrame): SourceContext | undefined {
	if (frame.contextLine === undefined) return undefined
	const pre = frame.preContext ?? []
	const post = frame.postContext ?? []
	return {
		lines: [...pre, frame.contextLine, ...post],
		errorIndex: pre.length,
		startLine: Math.max(1, (frame.line ?? pre.length + 1) - pre.length),
	}
}

function minifiedDisplay(frame: StackFrame): DisplayFrame {
	const result: DisplayFrame = {
		file: frameFile(frame) || 'unknown',
		function: frame.function ?? null,
		line: frame.line ?? null,
		column: frame.column ?? null,
		inApp: frame.inApp === true,
		resolved: false,
	}
	const source = rawSourceContext(frame)
	if (source) result.source = source
	return result
}

interface EventSourceMaps {
	consumerFor(fileReference: string): Promise<SourceMapConsumer | null>
	sourceLinesFor(consumer: SourceMapConsumer, source: string): string[] | null
}

function sourceLines(consumer: SourceMapConsumer, source: string): string[] | null {
	let content: string | null
	try {
		content = consumer.sourceContentFor(source, true)
	} catch {
		content = null
	}
	return content ? content.split('\n') : null
}

function mapSourceContext(allLines: string[] | null, line: number): SourceContext | undefined {
	if (!allLines) return undefined
	const start = Math.max(1, line - CONTEXT_RADIUS)
	const end = Math.min(allLines.length, line + CONTEXT_RADIUS)
	const lines = allLines.slice(start - 1, end)
	return lines.length === 0 ? undefined : { lines, errorIndex: line - start, startLine: start }
}

async function resolveOne(
	frame: StackFrame,
	maps: EventSourceMaps,
): Promise<DisplayFrame> {
	const fileReference = frameFile(frame)
	if (!fileReference || frame.line === undefined) return minifiedDisplay(frame)
	const consumer = await maps.consumerFor(fileReference)
	if (!consumer) return minifiedDisplay(frame)
	try {
		const position = consumer.originalPositionFor({
			line: frame.line,
			column: frame.column === undefined ? 0 : Math.max(0, frame.column - 1),
		})
		if (!position.source || position.line === null) return minifiedDisplay(frame)
		const result: DisplayFrame = {
			file: position.source,
			function: position.name ?? null,
			line: position.line,
			column: position.column === null ? null : position.column + 1,
			inApp: frame.inApp === true,
			resolved: true,
		}
		const source = mapSourceContext(maps.sourceLinesFor(consumer, position.source), position.line)
		if (source) result.source = source
		return result
	} catch {
		return minifiedDisplay(frame)
	}
}

function limitConcurrency(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
	let active = 0
	const waiting: Array<() => void> = []
	return async (work) => {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
		active++
		try {
			return await work()
		} finally {
			active--
			waiting.shift()?.()
		}
	}
}

function isResolvable(frame: StackFrame): boolean {
	return frameFile(frame) !== '' && frame.line !== undefined
}

interface FramePosition {
	stack: number
	index: number
}

// In-app frames first, then the top of each stack (Sentry orders frames oldest first), interleaving stacks.
function framesToResolve(stacks: StackFrame[][]): FramePosition[] {
	const inApp: FramePosition[] = []
	const other: FramePosition[] = []
	const deepest = Math.max(0, ...stacks.map((frames) => frames.length))
	for (let depth = 0; depth < deepest; depth++) {
		stacks.forEach((frames, stack) => {
			const index = frames.length - 1 - depth
			const frame = frames[index]
			if (frame === undefined || !isResolvable(frame)) return
			if (frame.inApp === true) inApp.push({ stack, index })
			else other.push({ stack, index })
		})
	}
	return [...inApp, ...other].slice(0, MAX_RESOLVED_FRAMES_PER_EVENT)
}

export async function resolveEventFrames(
	stacks: StackFrame[][],
	sourceId: string,
	release: string | undefined,
	reader: ObjectReader,
): Promise<DisplayFrame[][]> {
	const displays = stacks.map((frames) => frames.map(minifiedDisplay))
	if (!release) return displays
	const sourceMapRelease = release
	const consumers = new Map<string, Promise<SourceMapConsumer | null>>()
	const linesByConsumer = new Map<SourceMapConsumer, Map<string, string[] | null>>()
	const limitLoad = limitConcurrency(SOURCE_MAP_LOAD_CONCURRENCY)
	let remainingText = MAX_SOURCE_MAP_TEXT_PER_EVENT
	async function loadConsumer(key: string, logicalPath: string): Promise<SourceMapConsumer | null> {
		try {
			const object = reader.getSourceMap === undefined
				? await reader.get(key)
				: await reader.getSourceMap(sourceId, sourceMapRelease, logicalPath)
			if (!object) return null
			const text = await object.text()
			if (text.length > remainingText) return null
			remainingText -= text.length
			const map = parseRawSourceMap(JSON.parse(text))
			return map ? new SourceMapConsumer(map) : null
		} catch {
			return null
		}
	}
	function consumerFor(fileReference: string): Promise<SourceMapConsumer | null> {
		let logicalPath: string
		try {
			logicalPath = logicalAssetPath(fileReference)
		} catch {
			return Promise.resolve(null)
		}
		const key = sourceMapKey(sourceId, sourceMapRelease, logicalPath)
		const cached = consumers.get(key)
		if (cached !== undefined) return cached
		if (consumers.size >= MAX_SOURCE_MAPS_PER_EVENT) return Promise.resolve(null)
		const loading = limitLoad(() => loadConsumer(key, logicalPath))
		consumers.set(key, loading)
		return loading
	}
	function sourceLinesFor(consumer: SourceMapConsumer, source: string): string[] | null {
		let bySource = linesByConsumer.get(consumer)
		if (bySource === undefined) {
			bySource = new Map()
			linesByConsumer.set(consumer, bySource)
		}
		const cached = bySource.get(source)
		if (cached !== undefined) return cached
		const lines = sourceLines(consumer, source)
		bySource.set(source, lines)
		return lines
	}
	const maps: EventSourceMaps = { consumerFor, sourceLinesFor }
	await Promise.all(
		framesToResolve(stacks).map(async ({ stack, index }) => {
			const frame = stacks[stack]?.[index]
			const row = displays[stack]
			if (frame === undefined || row === undefined) return
			row[index] = await resolveOne(frame, maps)
		}),
	)
	return displays
}

// Resolves one stack as a whole event, so every caller gets the per-event caps.
export async function resolveFrames(
	frames: StackFrame[],
	sourceId: string,
	release: string | undefined,
	reader: ObjectReader,
): Promise<DisplayFrame[]> {
	const [displays] = await resolveEventFrames([frames], sourceId, release, reader)
	return displays ?? []
}
