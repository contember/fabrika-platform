import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import type { ReviewSource } from '../src/review/model'

/** A frame of a development stack, still in the bundle the page loaded. */
export interface BundleFrame {
	label: string
	url: string
	line: number
	column: number
}

const MAX_SOURCES = 6
const RESOLVE_TIMEOUT_MS = 3000
/** Frames inside React's element factory and scheduler, which every stack starts with. */
const REACT_INTERNAL =
	/\bat (?:[\w$]+\.)*(?:jsxDEV|jsxs?|createElement|react_stack_bottom_frame)\b|\/node_modules\/(?:\.vite\/deps\/)?react(?:-dom)?[/_]/

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function nameOf(type: unknown): string | undefined {
	if (typeof type === 'string') return type
	if (typeof type === 'function') return type.name === '' ? undefined : type.name.replace(/(?<=[a-z])\d+$/, '')
	if (isRecord(type)) return nameOf(type['type']) ?? nameOf(type['render'])
	return undefined
}

/** The first application frame of a stack: where the JSX was written. */
function creationFrame(stack: string): Omit<BundleFrame, 'label'> | undefined {
	for (const line of stack.split('\n').slice(1)) {
		if (REACT_INTERNAL.test(line)) continue
		const match = line.match(/\(?((?:https?|file):\/\/[^\s)]+):(\d+):(\d+)\)?\s*$/)
		if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
			return { url: match[1], line: Number(match[2]), column: Number(match[3]) }
		}
	}
	return undefined
}

/**
 * Where the element and its nearest components were created, read off React 19 development fibers (`_debugStack`).
 * Empty for other renderers and production builds.
 */
export function bundleFrames(element: Element): BundleFrame[] {
	const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'))
	if (fiberKey === undefined) return []
	const frames: BundleFrame[] = []
	let fiber: unknown = Reflect.get(element, fiberKey)
	for (let depth = 0; isRecord(fiber) && frames.length < MAX_SOURCES && depth < 60; depth++, fiber = fiber['return']) {
		const name = nameOf(fiber['type'])
		// Host elements other than the picked one, and components without a name, say nothing new.
		if (name === undefined || (frames.length > 0 && typeof fiber['type'] === 'string')) continue
		const stack = isRecord(fiber['_debugStack']) ? fiber['_debugStack']['stack'] : undefined
		if (typeof stack !== 'string') continue
		const frame = creationFrame(stack)
		if (frame === undefined) continue
		const owner = isRecord(fiber['_debugOwner']) ? nameOf(fiber['_debugOwner']['type']) : undefined
		frames.push({ label: owner === undefined ? `<${name}>` : `<${name}> in ${owner}`, ...frame })
	}
	return frames
}

const traceMaps = new Map<string, Promise<TraceMap | null>>()

async function loadTraceMap(scriptUrl: string): Promise<TraceMap | null> {
	const script = await fetch(scriptUrl).then((response) => response.text())
	const reference = [...script.matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)].at(-1)?.[1]
	if (reference === undefined) return null
	const mapUrl = new URL(reference, scriptUrl).href
	const map: unknown = await fetch(mapUrl).then((response) => response.json())
	if (!isRecord(map) || map['version'] !== 3) return null
	return new TraceMap(JSON.stringify(map), mapUrl)
}

function traceMapFor(scriptUrl: string): Promise<TraceMap | null> {
	let map = traceMaps.get(scriptUrl)
	if (map === undefined) {
		map = loadTraceMap(scriptUrl).catch(() => null)
		traceMaps.set(scriptUrl, map)
	}
	return map
}

function sourcePath(source: string): string {
	return source.startsWith('file://') ? decodeURIComponent(new URL(source).pathname) : source
}

async function resolveFrame(frame: BundleFrame): Promise<ReviewSource | null> {
	const map = await traceMapFor(frame.url)
	if (map === null) return null
	// Stack columns count from 1, source map columns from 0.
	const position = originalPositionFor(map, { line: frame.line, column: frame.column - 1 })
	if (position.source === null || position.line === null) return null
	return { label: frame.label, file: sourcePath(position.source), line: position.line, column: position.column + 1 }
}

/** Source positions of the frames, through the bundles' source maps; frames a map does not cover are left out. */
export async function resolveSources(frames: readonly BundleFrame[]): Promise<ReviewSource[]> {
	const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), RESOLVE_TIMEOUT_MS))
	const resolved = await Promise.race([Promise.all(frames.map((frame) => resolveFrame(frame).catch(() => null))), timeout])
	return resolved === null ? [] : resolved.filter((source) => source !== null)
}
