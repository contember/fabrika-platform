import type { DisplayFrame, SourceContext, StackFrame } from '@fabrika/operations-contract'
import { SourceMapConsumer } from 'source-map-js'
import type { RawSourceMap } from 'source-map-js'
import { z } from 'zod'

export interface ObjectReader {
	get(key: string): Promise<{ text(): Promise<string> } | null>
	getSourceMap?(sourceId: string, releaseName: string, logicalPath: string): Promise<{ text(): Promise<string> } | null>
}

const CONTEXT_RADIUS = 5

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

function mapSourceContext(consumer: SourceMapConsumer, source: string, line: number): SourceContext | undefined {
	let content: string | null
	try {
		content = consumer.sourceContentFor(source, true)
	} catch {
		content = null
	}
	if (!content) return undefined
	const allLines = content.split('\n')
	const start = Math.max(1, line - CONTEXT_RADIUS)
	const end = Math.min(allLines.length, line + CONTEXT_RADIUS)
	const lines = allLines.slice(start - 1, end)
	return lines.length === 0 ? undefined : { lines, errorIndex: line - start, startLine: start }
}

async function resolveOne(
	frame: StackFrame,
	consumerFor: (fileReference: string) => Promise<SourceMapConsumer | null>,
): Promise<DisplayFrame> {
	const fileReference = frameFile(frame)
	if (!fileReference || frame.line === undefined) return minifiedDisplay(frame)
	const consumer = await consumerFor(fileReference)
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
		const source = mapSourceContext(consumer, position.source, position.line)
		if (source) result.source = source
		return result
	} catch {
		return minifiedDisplay(frame)
	}
}

export async function resolveFrames(
	frames: StackFrame[],
	sourceId: string,
	release: string | undefined,
	reader: ObjectReader,
): Promise<DisplayFrame[]> {
	if (!release) return frames.map(minifiedDisplay)
	const sourceMapRelease = release
	const consumers = new Map<string, SourceMapConsumer | null>()
	async function consumerFor(fileReference: string): Promise<SourceMapConsumer | null> {
		let logicalPath: string
		try {
			logicalPath = logicalAssetPath(fileReference)
		} catch {
			return null
		}
		const key = sourceMapKey(sourceId, sourceMapRelease, logicalPath)
		if (consumers.has(key)) return consumers.get(key) ?? null
		let consumer: SourceMapConsumer | null = null
		try {
			const object = reader.getSourceMap === undefined
				? await reader.get(key)
				: await reader.getSourceMap(sourceId, sourceMapRelease, logicalPath)
			if (object) {
				const parsed: unknown = JSON.parse(await object.text())
				const map = parseRawSourceMap(parsed)
				if (map) consumer = new SourceMapConsumer(map)
			}
		} catch {
			consumer = null
		}
		consumers.set(key, consumer)
		return consumer
	}
	return Promise.all(frames.map((frame) => resolveOne(frame, consumerFor)))
}
