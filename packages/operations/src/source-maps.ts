import type { DisplayFrame, SourceContext, StackFrame } from '@fabrika/operations-contract'
import { SourceMapConsumer } from 'source-map-js'
import type { RawSourceMap } from 'source-map-js'

export interface ObjectReader {
	get(key: string): Promise<{ text(): Promise<string> } | null>
}

const CONTEXT_RADIUS = 5

function readStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null
	const strings: string[] = []
	for (const item of value) {
		if (typeof item !== 'string') return null
		strings.push(item)
	}
	return strings
}

function parseRawSourceMap(value: unknown): RawSourceMap | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
	if (!('sources' in value) || !('names' in value) || !('mappings' in value) || !('version' in value)) return null
	const sources = readStringArray(value.sources)
	const names = readStringArray(value.names)
	if (!sources || !names || typeof value.mappings !== 'string') return null
	if (typeof value.version !== 'string' && typeof value.version !== 'number') return null
	const result: RawSourceMap = {
		version: String(value.version),
		sources,
		names,
		mappings: value.mappings,
	}
	if ('file' in value && typeof value.file === 'string') result.file = value.file
	if ('sourceRoot' in value && typeof value.sourceRoot === 'string') result.sourceRoot = value.sourceRoot
	if ('sourcesContent' in value) {
		const sourcesContent = readStringArray(value.sourcesContent)
		if (!sourcesContent) return null
		result.sourcesContent = sourcesContent
	}
	return result
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

export function sourceMapKey(release: string, file: string): string {
	return `sourcemaps/${release}/${frameBasename(file)}.map`
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

export async function resolveFrames(frames: StackFrame[], release: string | undefined, reader: ObjectReader): Promise<DisplayFrame[]> {
	if (!release) return frames.map(minifiedDisplay)
	const sourceMapRelease = release
	const consumers = new Map<string, SourceMapConsumer | null>()
	async function consumerFor(fileReference: string): Promise<SourceMapConsumer | null> {
		const key = sourceMapKey(sourceMapRelease, fileReference)
		if (consumers.has(key)) return consumers.get(key) ?? null
		let consumer: SourceMapConsumer | null = null
		try {
			const object = await reader.get(key)
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
