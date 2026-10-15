// A thrown value as the Sentry exception values Operations ingests (ADR-0059): its type, its scrubbed message, its
// stack frames and its cause chain, each bounded so one event stays far below the ingest's size limit.

import { isStructuralError } from '../errors'
import { failureReason } from '../implement/failures'
import type { Scrubber } from './scrub'

/** A message is cut to this many characters. */
export const MAX_MESSAGE_LENGTH = 2_048
/** A file or function name is cut to this many characters. */
export const MAX_FRAME_FIELD_LENGTH = 512
/** The frames nearest the throw are kept. */
export const MAX_FRAMES = 50
/** The thrown value and at most this many minus one causes. */
export const MAX_CAUSE_DEPTH = 5
/** The encoded exception values stay within this; Operations refuses an ingest message above 120 KiB. */
export const MAX_EXCEPTION_BYTES = 64 * 1024

/** One stack frame in Sentry's shape. */
export interface ReportedFrame {
	readonly filename: string
	readonly function?: string
	readonly lineno?: number
	readonly colno?: number
	/** `false` for a dependency's or the runtime's own frame. */
	readonly in_app: boolean
}

/** One exception value in Sentry's shape. */
export interface ReportedException {
	readonly type: string
	readonly value: string
	readonly stacktrace?: { readonly frames: readonly ReportedFrame[] }
}

const FRAME_LINE = /^\s*at\s+(.*)$/
const LOCATION = /^(.*?)(?::(\d+))?(?::(\d+))?$/
const CALL = /^(.*?) \((.*)\)$/
/** An error's name is reported only when it is an identifier; anything else might be data. */
const TYPE_NAME = /^[A-Za-z_$][\w$.]{0,127}$/

function cut(text: string, length: number): string {
	return text.length <= length ? text : `${text.slice(0, length)}…`
}

/** A frame of the runtime, of a dependency, or without a position is no frame of the application. */
function inApp(filename: string, line: number | undefined): boolean {
	return line !== undefined
		&& !filename.includes('/node_modules/')
		&& !/^(?:node|bun|internal|native|wasm):/.test(filename)
		&& !/^(?:native|<anonymous>|\d*)$/.test(filename)
}

function parseFrame(text: string, scrubber: Scrubber): ReportedFrame | null {
	const body = FRAME_LINE.exec(text)?.[1]?.replace(/^async\s+/, '').trim()
	if (body === undefined || body === '') {
		return null
	}
	const call = CALL.exec(body)
	const name = call?.[1]?.trim()
	const where = LOCATION.exec(call?.[2] ?? body)
	const filename = cut(scrubber.scrub(where?.[1] ?? body), MAX_FRAME_FIELD_LENGTH)
	const line = where?.[2] === undefined ? undefined : Number(where[2])
	const column = where?.[3] === undefined ? undefined : Number(where[3])
	return {
		filename,
		...(name === undefined || name === '' ? {} : { function: cut(scrubber.scrub(name), MAX_FRAME_FIELD_LENGTH) }),
		...(line === undefined ? {} : { lineno: line }),
		...(column === undefined ? {} : { colno: column }),
		in_app: inApp(filename, line),
	}
}

/**
 * The frames of a V8 (Cloudflare Workers) or JavaScriptCore (Bun) `stack`, oldest call first as Sentry orders them,
 * the `MAX_FRAMES` nearest the throw kept. The message lines before the first frame are not read.
 */
export function parseStack(stack: string, scrubber: Scrubber): ReportedFrame[] {
	const frames = stack.split('\n').flatMap((line) => {
		const frame = parseFrame(line, scrubber)
		return frame === null ? [] : [frame]
	})
	return frames.slice(0, MAX_FRAMES).reverse()
}

function describe(error: unknown, scrubber: Scrubber): ReportedException {
	if (error instanceof Error) {
		const type = TYPE_NAME.test(error.name) ? scrubber.scrub(error.name) : 'Error'
		// A framework failure's message may quote request data or a row; its catalog text says the same without them.
		const why = failureReason(error)
		const value = why === null ? cut(scrubber.scrub(error.message), MAX_MESSAGE_LENGTH) : `${why.reason}: ${why.text}`
		const frames = typeof error.stack === 'string' ? parseStack(error.stack, scrubber) : []
		return frames.length === 0 ? { type, value } : { type, value, stacktrace: { frames } }
	}
	if (isStructuralError(error)) {
		return { type: TYPE_NAME.test(error.type) ? error.type : 'HttpError', value: cut(scrubber.scrub(error.message), MAX_MESSAGE_LENGTH) }
	}
	if (typeof error === 'string') {
		return { type: 'Error', value: cut(scrubber.scrub(error), MAX_MESSAGE_LENGTH) }
	}
	return { type: 'Error', value: `a thrown ${error === null ? 'null' : typeof error} that is not an Error` }
}

/**
 * `error` and its causes, at most `MAX_CAUSE_DEPTH`, the deepest cause first and `error` last, as Sentry orders a
 * chain. Every text is scrubbed and cut; the chain is then fitted within `MAX_EXCEPTION_BYTES`.
 */
export function exceptionChain(error: unknown, scrubber: Scrubber): ReportedException[] {
	const chain: ReportedException[] = []
	const seen = new Set<unknown>()
	let next: unknown = error
	while (chain.length < MAX_CAUSE_DEPTH && !seen.has(next)) {
		seen.add(next)
		chain.push(describe(next, scrubber))
		if (!(next instanceof Error) || next.cause === undefined) {
			break
		}
		next = next.cause
	}
	return fitWithin(chain.reverse(), MAX_EXCEPTION_BYTES)
}

const encodedSize = (values: readonly ReportedException[]): number => new TextEncoder().encode(JSON.stringify(values)).length

/** Drops the deepest causes, then halves the frames of what is left, until `values` encodes within `maxBytes`. */
export function fitWithin(values: readonly ReportedException[], maxBytes: number): ReportedException[] {
	let fitted = [...values]
	while (fitted.length > 1 && encodedSize(fitted) > maxBytes) {
		fitted = fitted.slice(1)
	}
	while (encodedSize(fitted) > maxBytes && fitted.some((value) => (value.stacktrace?.frames.length ?? 0) > 0)) {
		fitted = fitted.map((value) => {
			const frames = value.stacktrace?.frames ?? []
			const kept = frames.slice(Math.ceil(frames.length / 2))
			return kept.length === 0 ? { type: value.type, value: value.value } : { ...value, stacktrace: { frames: kept } }
		})
	}
	return fitted
}
