// A fixed input that a schema shape admits, written into a generated test as a literal. Deterministic, so the checker
// regenerates the same text; `undefined` when the scaffold cannot build one (a pattern, contradictory bounds).

import type { NumberShape, SchemaShape, StringShape } from '@fabrika/auth-core'

export type Sample = null | boolean | number | string | readonly Sample[] | { readonly [key: string]: Sample }

/** What a shape contributes to its object: a value, nothing (an optional field), or no sample at all. */
type Field = { readonly kind: 'value'; readonly value: Sample } | { readonly kind: 'omit' } | undefined

const FORMATS: Readonly<Record<NonNullable<StringShape['format']>, string>> = {
	uuid: '00000000-0000-4000-8000-000000000000',
	email: 'sample@example.test',
	url: 'https://example.test/',
	datetime: '2026-01-01T00:00:00.000Z',
	date: '2026-01-01',
	time: '12:00:00',
	duration: 'PT1H',
}

function sampleString(shape: StringShape): string | undefined {
	if (shape.pattern !== null) return undefined
	if (shape.format !== null) return FORMATS[shape.format]
	let value = `${shape.startsWith ?? ''}${shape.includes ?? ''}${shape.endsWith ?? ''}`
	const least = Math.max(shape.minLength ?? 1, 1)
	if (value.length < least) {
		value = `${shape.startsWith ?? ''}${shape.includes ?? ''}${'x'.repeat(least - value.length)}${shape.endsWith ?? ''}`
	}
	return shape.maxLength !== null && value.length > shape.maxLength ? undefined : value
}

function admits(shape: NumberShape, value: number): boolean {
	if (shape.int && !Number.isInteger(value)) return false
	if (shape.min !== null && (shape.exclusiveMin ? value <= shape.min : value < shape.min)) return false
	if (shape.max !== null && (shape.exclusiveMax ? value >= shape.max : value > shape.max)) return false
	return shape.multipleOf === null || Number.isInteger(value / shape.multipleOf)
}

function sampleNumber(shape: NumberShape): number | undefined {
	const step = shape.multipleOf ?? 1
	const start = shape.min ?? (shape.max === null ? 1 : Math.min(1, shape.max))
	const first = Math.ceil(start / step) * step
	return [first, first + step].find((candidate) => admits(shape, candidate))
}

function field(shape: SchemaShape): Field {
	if (shape.type === 'optional') return { kind: 'omit' }
	const value = sample(shape)
	return value === undefined ? undefined : { kind: 'value', value }
}

/** A value `shape` admits, or `undefined`. */
export function sample(shape: SchemaShape): Sample | undefined {
	switch (shape.type) {
		case 'string':
			return sampleString(shape)
		case 'number':
			return sampleNumber(shape)
		case 'boolean':
			return false
		case 'null':
			return null
		case 'literal':
			return shape.value
		case 'enum':
			return shape.values[0]
		case 'optional':
			return sample(shape.inner)
		case 'nullable':
			return null
		case 'union':
			return shape.options.map(sample).find((value) => value !== undefined)
		case 'record':
			return {}
		case 'array': {
			const count = shape.minItems ?? 0
			const item = count === 0 ? null : sample(shape.items)
			return item === undefined ? undefined : Array.from({ length: count }, () => item)
		}
		case 'tuple': {
			const items = shape.items.map(sample)
			return items.every((item) => item !== undefined) ? items.filter((item) => item !== undefined) : undefined
		}
		case 'object': {
			const entries: [string, Sample][] = []
			for (const [name, inner] of Object.entries(shape.fields).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
				const result = field(inner)
				if (result === undefined) return undefined
				if (result.kind === 'value') entries.push([name, result.value])
			}
			return Object.fromEntries(entries)
		}
	}
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const quote = (text: string): string => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

/** The literal as dprint writes it: single quotes, bare keys where they are identifiers. */
export function renderSample(value: Sample): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'number') return String(value)
	if (typeof value === 'string') return quote(value)
	if (Array.isArray(value)) return `[${value.map(renderSample).join(', ')}]`
	const entries = Object.entries(value)
	if (entries.length === 0) return '{}'
	return `{ ${entries.map(([key, item]) => `${IDENTIFIER.test(key) ? key : quote(key)}: ${renderSample(item)}`).join(', ')} }`
}
