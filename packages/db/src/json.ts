// JSON columns at the layer's boundary: `jsonb` on Postgres, a column declared `JSONB` on SQLite (the column list's
// `json`). A write takes a JSON value, checked and serialized here, and binds its text as one parameter: Postgres reads
// an untyped text parameter into `jsonb`, SQLite stores the text. A read answers the parsed value: `Bun.SQL` decodes
// `jsonb` itself, and `sqliteJson` parses SQLite's text. JS `null` is SQL NULL in both directions, so a top-level JSON
// `null` written by `ctx.sql` reads as `null` too. A JSON column is never compared, ordered, grouped or aggregated by
// the layer; a path condition is `ctx.sql`'s (`->>`).

import { hasOwn, isArray, OBJECT_PROTOTYPE, ownDescriptor, ownNames, ownSymbols, parseList, prototypeOf } from './builtins'
import { QueryRefusedError } from './errors'

const stringify = JSON.stringify
const parse = JSON.parse
const isFinite = Number.isFinite

/** A JSON value: what `JSON.parse` answers. An object member that is `undefined` is left out, as `JSON.stringify` does. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue | undefined }

/** What a JSON column takes: a JSON value other than a top-level `null`, which the layer writes as SQL NULL. */
export type JsonColumnValue = Exclude<JsonValue, null>

/** How deep a written value may nest; deeper is refused, and so is a value that contains itself. */
export const MAX_JSON_DEPTH = 64

function refusal(where: string, detail: string): QueryRefusedError {
	return new QueryRefusedError('invalid_value', `${where} takes a JSON value (${detail})`)
}

function written(value: unknown, where: string, depth: number): string {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return stringify(value)
	}
	if (typeof value === 'number') {
		if (!isFinite(value)) {
			throw refusal(where, 'a number is finite')
		}
		return stringify(value)
	}
	if (typeof value !== 'object') {
		throw refusal(where, `${typeof value} is not JSON`)
	}
	if (depth >= MAX_JSON_DEPTH) {
		throw refusal(where, `nested at most ${MAX_JSON_DEPTH} deep, and never containing itself`)
	}
	if (isArray(value)) {
		const items = parseList(value, (item) => {
			if (item === undefined) {
				throw refusal(where, 'an array holds no undefined')
			}
			return written(item, where, depth + 1)
		})
		if (items === undefined) {
			throw refusal(where, 'an array is a plain array without holes or accessors')
		}
		let text = '['
		for (let index = 0; index < items.length; index++) {
			text += `${index === 0 ? '' : ','}${items[index] ?? ''}`
		}
		return `${text}]`
	}
	const prototype: unknown = prototypeOf(value)
	if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
		throw refusal(where, 'an object is a plain object, not an instance of a class such as a Date or a Map')
	}
	if (ownSymbols(value).length > 0) {
		throw refusal(where, 'an object has string keys only')
	}
	const keys = ownNames(value)
	let text = '{'
	let first = true
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		const descriptor = ownDescriptor(value, key)
		if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
			throw refusal(where, `${key} is an accessor`)
		}
		const member: unknown = descriptor.value
		if (member === undefined) {
			continue
		}
		text += `${first ? '' : ','}${stringify(key)}:${written(member, where, depth + 1)}`
		first = false
	}
	return `${text}}`
}

/**
 * A written JSON column value as the text the layer binds: plain objects and arrays, strings, finite numbers, booleans
 * and nested `null`, read through own data properties only, so no `toJSON`, getter or method of the value runs.
 */
export function jsonInput(value: unknown, where: string): string {
	return written(value, where, 0)
}

/**
 * A SQLite JSON column's stored value as Postgres's driver answers `jsonb`: its text parsed. A `JSONB` column has
 * NUMERIC affinity, so a written number comes back as a number, which is that JSON value already.
 */
export function sqliteJson(value: unknown, where: string): unknown {
	if (typeof value === 'number') {
		return value
	}
	if (typeof value === 'string') {
		try {
			return parse(value)
		} catch {
			// Fall through: the text is not JSON, which no write of the layer stores.
		}
	}
	throw new QueryRefusedError('unexpected_row', `${where} came back as something other than JSON text, the form a JSON column is stored in on SQLite`)
}
