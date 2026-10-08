// The endpoint matcher of contract applications. It selects; it evaluates no gate rule. The proxy and the framework
// both select with it, so a request reaches the endpoint whose rules the proxy applied.

import { isCanonicalPath } from './canonical-path'
import type { EndpointMethod, EndpointRow, EndpointTable } from './contract'
import { parameterName } from './path-segment'

type Segment = { readonly kind: 'literal'; readonly value: string } | { readonly kind: 'param'; readonly name: string } | {
	readonly kind: 'wildcard'
}

type PatternResult = { readonly ok: true; readonly segments: readonly Segment[] } | { readonly ok: false; readonly problem: string }

/** What selection reads of a row. The proxy's manifest rows carry these and the rules, not the schemas. */
export type EndpointPattern = Pick<EndpointRow, 'id' | 'method' | 'path'>

/** A table of any rows that carry an endpoint pattern; `EndpointTable` is the artifact's. */
export interface EndpointPatternTable<Row extends EndpointPattern> {
	readonly endpoints: readonly Row[]
	readonly reservedPrefixes: readonly string[]
}

interface CompiledEndpoint<Row extends EndpointPattern> {
	readonly row: Row
	readonly segments: readonly Segment[]
}

/** An endpoint table that `assertNoAmbiguity` accepted, ready for `planEndpoint`. Only `compileEndpointTable` makes one. */
class CompiledEndpointTable<Row extends EndpointPattern = EndpointRow> {
	readonly #endpoints: readonly CompiledEndpoint<Row>[]
	readonly #reservedPrefixes: readonly string[]

	constructor(endpoints: readonly CompiledEndpoint<Row>[], reservedPrefixes: readonly string[]) {
		this.#endpoints = endpoints
		this.#reservedPrefixes = reservedPrefixes
	}

	plan(method: string, rawPath: string): EndpointPlan<Row> {
		return select(this.#endpoints, this.#reservedPrefixes, method, rawPath)
	}
}

export type { CompiledEndpointTable }

/** `no-endpoint` is a 403 at the proxy and a 404 in the framework; `non-canonical` is a 400 at both. */
export type EndpointPlan<Row extends EndpointPattern = EndpointRow> =
	| { readonly outcome: 'non-canonical' }
	| { readonly outcome: 'no-endpoint' }
	| {
		readonly outcome: 'endpoint'
		readonly endpoint: Row
		/** `:name` segments of the selected path, raw and still percent-encoded. */
		readonly params: Readonly<Record<string, string>>
	}

export class EndpointTableError extends Error {
	override readonly name = 'EndpointTableError'
	readonly problems: readonly string[]

	constructor(problems: readonly string[]) {
		super(`the endpoint table is invalid:\n- ${problems.join('\n- ')}`)
		this.problems = problems
	}
}

/**
 * Refuse a table in which a request could select an endpoint by accident: an invalid path or reserved prefix, a
 * duplicate id, or two endpoints of one method whose paths have the same shape, which no specificity orders.
 */
export function assertNoAmbiguity<Row extends EndpointPattern>(table: EndpointPatternTable<Row>): void {
	analyse(table)
}

/** Validate a table once, where it is loaded, so that `planEndpoint` never meets an invalid one. */
export function compileEndpointTable<Row extends EndpointPattern = EndpointRow>(table: EndpointPatternTable<Row>): CompiledEndpointTable<Row> {
	return new CompiledEndpointTable(analyse(table), [...table.reservedPrefixes])
}

/**
 * Select the endpoint for a request: refuse a non-canonical raw path, then take the most specific endpoint of the
 * request's method. Under a reserved prefix only the endpoints declared under it compete. There is no fall-through.
 */
export function planEndpoint<Row extends EndpointPattern>(table: CompiledEndpointTable<Row>, method: string, rawPath: string): EndpointPlan<Row> {
	return table.plan(method, rawPath)
}

/**
 * The rows, most specific first, in the order `planEndpoint` prefers them. For rows of one method, the first row
 * whose path matches is the one `planEndpoint` selects, so gates emitted in this order agree with the table.
 */
export function orderBySpecificity(rows: readonly EndpointRow[]): EndpointRow[] {
	const compiled = rows.map((row) => ({ row, segments: patternOrThrow(row.path, row.id) }))
	return compiled.sort((a, b) => compareSpecificity(a.segments, b.segments)).map(({ row }) => row)
}

/**
 * The rows of `method` that `planEndpoint` may select for a request whose most specific matching row path, over
 * every method, is `path`. A gate knows no method, so the gate generated for `path` must admit all of them. When
 * `path` has a row of `method`, that row is the answer; otherwise every overlapping row that is not more specific
 * than `path` may be, so the result may name a row such a request never selects, but never misses one.
 */
export function selectableRows(table: EndpointTable, path: string, method: EndpointMethod): EndpointRow[] {
	const target = patternOrThrow(path, path)
	const reserved = longestPrefixOf(path, table.reservedPrefixes)
	const candidates = table.endpoints
		.filter((row) => row.method === method && (reserved === null || isUnder(row.path, reserved)))
		.map((row) => ({ row, segments: patternOrThrow(row.path, row.id) }))
	const shape = JSON.stringify(target.map(shapeOf))
	const same = candidates.find(({ segments }) => JSON.stringify(segments.map(shapeOf)) === shape)
	if (same !== undefined) {
		return [same.row]
	}
	return candidates
		.filter(({ segments }) => compareSpecificity(segments, target) >= 0 && overlaps(segments, target))
		.map(({ row }) => row)
}

function patternOrThrow(path: string, id: string): readonly Segment[] {
	const pattern = parsePattern(path)
	if (!pattern.ok) {
		throw new EndpointTableError([`endpoint '${id}' has path '${path}': ${pattern.problem}`])
	}
	return pattern.segments
}

function analyse<Row extends EndpointPattern>(table: EndpointPatternTable<Row>): CompiledEndpoint<Row>[] {
	const problems: string[] = []
	const endpoints: CompiledEndpoint<Row>[] = []
	const ids = new Set<string>()
	const shapes = new Map<string, string>()
	for (const row of table.endpoints) {
		if (ids.has(row.id)) {
			problems.push(`endpoint id '${row.id}' is declared twice`)
		}
		ids.add(row.id)
		const pattern = parsePattern(row.path)
		if (!pattern.ok) {
			problems.push(`endpoint '${row.id}' has path '${row.path}': ${pattern.problem}`)
			continue
		}
		const shape = `${row.method} ${JSON.stringify(pattern.segments.map(shapeOf))}`
		const previous = shapes.get(shape)
		if (previous !== undefined) {
			problems.push(`'${row.id}' and '${previous}' both serve ${row.method} ${row.path}`)
		}
		shapes.set(shape, row.id)
		endpoints.push({ row, segments: pattern.segments })
	}
	const prefixes = new Set<string>()
	for (const prefix of table.reservedPrefixes) {
		if (!isReservedPrefix(prefix)) {
			problems.push(`reserved prefix '${prefix}' must be a literal path below the root, without a trailing '/'`)
		} else if (prefixes.has(prefix)) {
			problems.push(`reserved prefix '${prefix}' is declared twice`)
		}
		prefixes.add(prefix)
	}
	if (problems.length > 0) {
		throw new EndpointTableError(problems)
	}
	return endpoints
}

function select<Row extends EndpointPattern>(
	endpoints: readonly CompiledEndpoint<Row>[],
	reservedPrefixes: readonly string[],
	method: string,
	rawPath: string,
): EndpointPlan<Row> {
	if (!isCanonicalPath(rawPath)) {
		return { outcome: 'non-canonical' }
	}
	const path = splitPath(rawPath)
	const reserved = longestPrefixOf(rawPath, reservedPrefixes)
	let best: { readonly endpoint: CompiledEndpoint<Row>; readonly params: Record<string, string> } | null = null
	let tied = false
	for (const endpoint of endpoints) {
		if (endpoint.row.method !== method || (reserved !== null && !isUnder(endpoint.row.path, reserved))) {
			continue
		}
		const params = matchSegments(endpoint.segments, path)
		if (params === null) {
			continue
		}
		const order = best === null ? -1 : compareSpecificity(endpoint.segments, best.endpoint.segments)
		if (order < 0) {
			best = { endpoint, params }
			tied = false
		} else if (order === 0) {
			tied = true
		}
	}
	// A tie cannot survive `assertNoAmbiguity`; if one ever appears, nothing is selected.
	if (best === null || tied) {
		return { outcome: 'no-endpoint' }
	}
	return { outcome: 'endpoint', endpoint: best.endpoint.row, params: best.params }
}

/** Split literally: a trailing `/` stays an empty last segment, so `/a/` and `/a` are different paths. */
function splitPath(path: string): string[] {
	return path === '/' ? [] : path.slice(1).split('/')
}

/** Names that would reach `Object.prototype` instead of a parameter wherever the parameters land in a plain object. */
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

function parsePattern(path: string): PatternResult {
	if (!isCanonicalPath(path)) {
		return { ok: false, problem: 'not a canonical path' }
	}
	const raw = splitPath(path)
	const segments: Segment[] = []
	const names = new Set<string>()
	for (const [index, segment] of raw.entries()) {
		if (segment === '*') {
			if (index !== raw.length - 1) {
				return { ok: false, problem: "'*' must be the last segment" }
			}
			segments.push({ kind: 'wildcard' })
		} else if (segment.includes('*')) {
			return { ok: false, problem: "'*' must be a whole segment" }
		} else if (segment.startsWith(':')) {
			const name = parameterName(segment)
			if (name === null) {
				return { ok: false, problem: "':' must start a parameter name of letters, digits and '_'" }
			}
			if (PROTOTYPE_NAMES.has(name)) {
				return { ok: false, problem: `'${name}' is not allowed as a parameter name` }
			}
			if (names.has(name)) {
				return { ok: false, problem: `parameter '${name}' is declared twice` }
			}
			names.add(name)
			segments.push({ kind: 'param', name })
		} else {
			segments.push({ kind: 'literal', value: segment })
		}
	}
	return { ok: true, segments }
}

function isReservedPrefix(prefix: string): boolean {
	const pattern = parsePattern(prefix)
	return pattern.ok && pattern.segments.length > 0 && !prefix.endsWith('/')
		&& pattern.segments.every((segment) => segment.kind === 'literal')
}

function isUnder(path: string, prefix: string): boolean {
	return path.startsWith(`${prefix}/`)
}

function longestPrefixOf(path: string, prefixes: readonly string[]): string | null {
	let longest: string | null = null
	for (const prefix of prefixes) {
		if (isUnder(path, prefix) && (longest === null || prefix.length > longest.length)) {
			longest = prefix
		}
	}
	return longest
}

function shapeOf(segment: Segment): string {
	return segment.kind === 'literal' ? `=${segment.value}` : segment.kind
}

function matchSegments(segments: readonly Segment[], path: readonly string[]): Record<string, string> | null {
	const params: [string, string][] = []
	for (const [index, segment] of segments.entries()) {
		if (segment.kind === 'wildcard') {
			// Like the gate glob `/x/*`, a non-root wildcard needs the `/` before it: `/x/` matches, `/x` does not.
			return index === 0 || path.length > index ? Object.fromEntries(params) : null
		}
		const value = path[index]
		if (value === undefined) {
			return null
		}
		if (segment.kind === 'param') {
			// The empty last segment of a trailing `/` is not a parameter value.
			if (value === '') {
				return null
			}
			params.push([segment.name, value])
		} else if (segment.value !== value) {
			return null
		}
	}
	// `fromEntries` defines own properties, so no name reaches a prototype setter.
	return segments.length === path.length ? Object.fromEntries(params) : null
}

/** Whether some path matches both patterns, under the rules of `matchSegments`. */
function overlaps(a: readonly Segment[], b: readonly Segment[]): boolean {
	for (let index = 0;; index++) {
		const left = a[index]
		const right = b[index]
		if (left?.kind === 'wildcard' || right?.kind === 'wildcard') {
			// A non-root wildcard needs a segment at its own index; the other pattern supplies one unless it ends there.
			const other = left?.kind === 'wildcard' ? b : a
			return index === 0 || other.length > index
		}
		if (left === undefined || right === undefined) {
			return left === right
		}
		if (!segmentsOverlap(left, right)) {
			return false
		}
	}
}

/** A parameter takes any one non-empty segment, so it meets every literal but the empty last segment of a trailing `/`. */
function segmentsOverlap(left: Segment, right: Segment): boolean {
	if (left.kind === 'literal' && right.kind === 'literal') {
		return left.value === right.value
	}
	const literal = left.kind === 'literal' ? left : right.kind === 'literal' ? right : null
	return literal === null || literal.value !== ''
}

const RANK: Readonly<Record<Segment['kind'], number>> = { literal: 0, param: 1, wildcard: 2 }

/**
 * Negative when `a` is more specific: the first segment whose kind differs decides, and a pattern that ends where
 * the other continues is the more specific one. Lexicographic, so it also orders patterns that never overlap.
 */
function compareSpecificity(a: readonly Segment[], b: readonly Segment[]): number {
	const shared = Math.min(a.length, b.length)
	for (let index = 0; index < shared; index++) {
		const left = a[index]
		const right = b[index]
		if (left === undefined || right === undefined) {
			break
		}
		const order = RANK[left.kind] - RANK[right.kind]
		if (order !== 0) {
			return order
		}
	}
	return a.length - b.length
}
