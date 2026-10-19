// Flat scalar parameters: a GET procedure's input and a POST's `query` from the URL, and a native form's urlencoded body.
// Each parameter becomes the value its field's schema reads: a string as it is, a number, a boolean and `null` only in
// their canonical spelling, so one value has one URL. A name sent twice is refused; an unknown name is the strict
// input's to refuse.

import type { SchemaShape } from '@fabrika/auth-core'
import { BadRequestError, HttpError } from '../errors'

/** The longest URL a procedure reads its parameters from. */
export const MAX_URL_LENGTH = 8192

/** The parameters of `params` as the object `shape`'s fields read them; `shape` is a flat object, or `null` for none. */
export function paramsObject(params: URLSearchParams, shape: SchemaShape | null): Record<string, unknown> {
	const fields = shape?.type === 'object' ? shape.fields : {}
	const read: Record<string, unknown> = {}
	for (const [name, value] of params) {
		if (Object.hasOwn(read, name)) {
			throw new BadRequestError(`the parameter '${name}' is sent twice`)
		}
		const field = Object.hasOwn(fields, name) ? fields[name] : undefined
		read[name] = field === undefined ? value : scalarOf(field, value)
	}
	return read
}

/** The URL's parameters of a request, within `MAX_URL_LENGTH`. */
export function urlParams(request: Request): URLSearchParams {
	if (request.url.length > MAX_URL_LENGTH) {
		throw new HttpError(414, 'url_too_long', `The URL is longer than ${MAX_URL_LENGTH} characters`)
	}
	return new URL(request.url).searchParams
}

/** A parameter's value as `shape` reads it; a value no alternative spells canonically stays text, for the schema to refuse. */
function scalarOf(shape: SchemaShape, value: string): unknown {
	switch (shape.type) {
		case 'optional':
			return scalarOf(shape.inner, value)
		case 'nullable':
			return value === 'null' && !readsText(shape.inner) ? null : scalarOf(shape.inner, value)
		case 'number':
			return canonicalNumber(value) ?? value
		case 'boolean':
			return value === 'true' ? true : value === 'false' ? false : value
		case 'null':
			return value === 'null' ? null : value
		case 'literal':
			return typeof shape.value === 'string' ? value : scalarOf(literalShape(shape.value), value)
		case 'union':
			for (const option of shape.options) {
				const read = scalarOf(option, value)
				if (read !== value || readsText(option)) return read
			}
			return value
		default:
			return value
	}
}

function literalShape(value: number | boolean | null): SchemaShape {
	if (value === null) return { type: 'null' }
	if (typeof value === 'boolean') return { type: 'boolean' }
	return { type: 'number', int: false, min: null, exclusiveMin: false, max: null, exclusiveMax: false, multipleOf: null }
}

/** Whether the shape reads text as itself, so `null` and `true` stay strings there. */
function readsText(shape: SchemaShape): boolean {
	switch (shape.type) {
		case 'string':
		case 'enum':
			return true
		case 'literal':
			return typeof shape.value === 'string'
		case 'optional':
		case 'nullable':
			return readsText(shape.inner)
		case 'union':
			return shape.options.some(readsText)
		default:
			return false
	}
}

/** `value` as a number when it is that number's canonical spelling (`1.5`, `-3`, never `01`, `1e3` or `+2`). */
function canonicalNumber(value: string): number | null {
	const number = Number(value)
	return value !== '' && Number.isFinite(number) && String(number) === value ? number : null
}
