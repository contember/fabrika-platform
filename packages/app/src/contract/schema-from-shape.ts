// A `SchemaShape` turned back into a zod schema, and the part of a validation issue's path that the shape declares.
// A connector validates against schemas built here from the snapshot's description, never against the application's
// own schema objects, which application code could change after `boot` checked them.

import type { SchemaShape, StringShape } from '@fabrika/auth-core'
import { z } from 'zod/v4'
import { SIGNED_TOKEN_MAX_LENGTH } from './token'

/** The zod schema that admits what `shape` describes; `describeSchema` reads it back into the same shape. */
export function schemaFromShape(shape: SchemaShape): z.ZodType {
	switch (shape.type) {
		case 'string':
			return stringSchema(shape)
		case 'number': {
			let schema = shape.int ? z.int() : z.number()
			if (shape.min !== null) {
				schema = shape.exclusiveMin ? schema.gt(shape.min) : schema.gte(shape.min)
			}
			if (shape.max !== null) {
				schema = shape.exclusiveMax ? schema.lt(shape.max) : schema.lte(shape.max)
			}
			return shape.multipleOf === null ? schema : schema.multipleOf(shape.multipleOf)
		}
		case 'boolean':
			return z.boolean()
		case 'null':
			return z.null()
		case 'literal':
			return z.literal(shape.value)
		case 'enum': {
			const [first, ...rest] = shape.values
			return first === undefined ? z.never() : z.enum([first, ...rest])
		}
		case 'array': {
			let schema = z.array(schemaFromShape(shape.items))
			if (shape.minItems !== null) {
				schema = schema.min(shape.minItems)
			}
			return shape.maxItems === null ? schema : schema.max(shape.maxItems)
		}
		case 'tuple': {
			const [first, ...rest] = shape.items.map(schemaFromShape)
			if (first === undefined) {
				// A tuple of no fixed items and a rest admits what an array of the rest admits.
				return shape.rest === null ? z.tuple([]) : z.array(schemaFromShape(shape.rest))
			}
			return shape.rest === null ? z.tuple([first, ...rest]) : z.tuple([first, ...rest], schemaFromShape(shape.rest))
		}
		case 'record':
			return z.record(recordKey(shape.key), schemaFromShape(shape.value))
		case 'object':
			return z.strictObject(Object.fromEntries(Object.entries(shape.fields).map(([name, field]) => [name, schemaFromShape(field)])))
		case 'optional':
			return z.optional(schemaFromShape(shape.inner))
		case 'nullable':
			return z.nullable(schemaFromShape(shape.inner))
		case 'union':
			return z.union(shape.options.map(schemaFromShape))
		case 'token':
			// The text of a signed token; the runtime verifies it and hands the handler its claims.
			return z.string().min(1).max(SIGNED_TOKEN_MAX_LENGTH)
		case 'file':
			// No export carries a file: the build refuses one, so a description that holds one admits nothing.
			return z.never()
	}
}

/** A record's keys are strings: a string, a string literal, an enum or a union of them; any other key admits nothing. */
function recordKey(shape: SchemaShape): z.ZodType<string, string> {
	switch (shape.type) {
		case 'string':
			return stringSchema(shape)
		case 'enum': {
			const [first, ...rest] = shape.values
			return first === undefined ? z.never() : z.enum([first, ...rest])
		}
		case 'literal':
			return typeof shape.value === 'string' ? z.literal(shape.value) : z.never()
		case 'union':
			return z.union(shape.options.map(recordKey))
		default:
			return z.never()
	}
}

function stringSchema(shape: StringShape): z.ZodType<string, string> {
	let schema: z.ZodString | z.ZodStringFormat = formatSchema(shape.format)
	if (shape.minLength !== null) {
		schema = schema.min(shape.minLength)
	}
	if (shape.maxLength !== null) {
		schema = schema.max(shape.maxLength)
	}
	if (shape.pattern !== null) {
		schema = schema.regex(new RegExp(shape.pattern))
	}
	if (shape.startsWith !== null) {
		schema = schema.startsWith(shape.startsWith)
	}
	if (shape.endsWith !== null) {
		schema = schema.endsWith(shape.endsWith)
	}
	return shape.includes === null ? schema : schema.includes(shape.includes)
}

function formatSchema(format: StringShape['format']): z.ZodString | z.ZodStringFormat {
	switch (format) {
		case null:
			return z.string()
		case 'uuid':
			return z.uuid()
		case 'email':
			return z.email()
		case 'url':
			return z.url()
		case 'datetime':
			return z.iso.datetime()
		case 'date':
			return z.iso.date()
		case 'time':
			return z.iso.time()
		case 'duration':
			return z.iso.duration()
	}
}

/**
 * The path of a validation issue as far as `shape` declares it: field names the schema names, `[]` for an array item,
 * a tuple position, `{}` for a record value. Record keys and array indexes come from the value, which another
 * application wrote, so they never reach a message or a log.
 */
export function declaredPath(shape: SchemaShape, path: readonly PropertyKey[]): string {
	let current: SchemaShape = shape
	let rendered = ''
	for (const segment of path) {
		while (current.type === 'optional' || current.type === 'nullable') {
			current = current.inner
		}
		if (current.type === 'object' && typeof segment === 'string' && Object.hasOwn(current.fields, segment)) {
			rendered += rendered === '' ? segment : `.${segment}`
			current = current.fields[segment] ?? current
		} else if (current.type === 'array') {
			rendered += '[]'
			current = current.items
		} else if (current.type === 'tuple' && typeof segment === 'number' && segment < current.items.length) {
			rendered += `[${segment}]`
			current = current.items[segment] ?? current
		} else if (current.type === 'tuple' && current.rest !== null) {
			rendered += '[]'
			current = current.rest
		} else if (current.type === 'record') {
			rendered += '{}'
			current = current.value
		} else {
			break
		}
	}
	return rendered === '' ? '(root)' : rendered
}
