// Output projection: a handler's return value reduced to the fields its output schema declares. The strict output
// schema then validates what is left, so an undeclared field is dropped rather than leaked or refused.

import type { SchemaShape } from '@fabrika/auth-core'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` could be an instance of `shape` at its top level; it picks the union option to project with. */
function fits(shape: SchemaShape, value: unknown): boolean {
	switch (shape.type) {
		case 'string':
		case 'enum':
			return typeof value === 'string'
		case 'number':
			return typeof value === 'number'
		case 'boolean':
			return typeof value === 'boolean'
		case 'null':
			return value === null
		case 'literal':
			return value === shape.value
		case 'array':
		case 'tuple':
			return Array.isArray(value)
		case 'record':
			return isRecord(value)
		case 'object':
			return isRecord(value) && Object.entries(shape.fields).every(([name, field]) => {
				const own = Object.hasOwn(value, name)
				if (field.type === 'literal') {
					return own && value[name] === field.value
				}
				return own || field.type === 'optional'
			})
		case 'optional':
			return value === undefined || fits(shape.inner, value)
		case 'nullable':
			return value === null || fits(shape.inner, value)
		case 'union':
			return shape.options.some((option) => fits(option, value))
	}
}

/** `value` with every object reduced to its declared fields, recursively. Anything else is left for validation. */
export function project(shape: SchemaShape, value: unknown): unknown {
	switch (shape.type) {
		case 'object': {
			if (!isRecord(value)) {
				return value
			}
			const declared = Object.entries(shape.fields).filter(([name]) => Object.hasOwn(value, name))
			// `fromEntries` defines own properties, so a `__proto__` key never reaches a prototype setter.
			return Object.fromEntries(declared.map(([name, field]) => [name, project(field, value[name])]))
		}
		case 'array':
			return Array.isArray(value) ? value.map((item: unknown) => project(shape.items, item)) : value
		case 'tuple':
			return Array.isArray(value)
				? value.map((item: unknown, index) => {
					const position = shape.items[index] ?? shape.rest
					return position === null || position === undefined ? item : project(position, item)
				})
				: value
		case 'record': {
			if (!isRecord(value)) {
				return value
			}
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(shape.value, item)]))
		}
		case 'optional':
			return value === undefined ? value : project(shape.inner, value)
		case 'nullable':
			return value === null ? value : project(shape.inner, value)
		case 'union': {
			const option = shape.options.find((candidate) => fits(candidate, value))
			return option === undefined ? value : project(option, value)
		}
		default:
			return value
	}
}
