// Output projection: a handler's return value reduced to the fields its output schema declares. The strict output
// schema then validates what is left, so an undeclared field is dropped rather than leaked or refused.

import { z } from 'zod/v4'

/** No branch of a union accepts the value, whatever it is reduced to. */
export class ProjectionRefusedError extends Error {
	override readonly name = 'ProjectionRefusedError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `value` with every object reduced to the fields `schema` declares, recursively. A union takes the first branch,
 * in declaration order, whose schema accepts the value reduced to that branch. Anything else is left for
 * validation.
 */
export function project(schema: z.core.$ZodType, value: unknown): unknown {
	if (schema instanceof z.core.$ZodObject) {
		if (!isRecord(value)) {
			return value
		}
		const declared = Object.entries(schema._zod.def.shape).filter(([name]) => Object.hasOwn(value, name))
		// `fromEntries` defines own properties, so a `__proto__` key never reaches a prototype setter.
		return Object.fromEntries(declared.map(([name, field]) => [name, project(field, value[name])]))
	}
	if (schema instanceof z.core.$ZodArray) {
		const element = schema._zod.def.element
		return Array.isArray(value) ? value.map((item: unknown) => project(element, item)) : value
	}
	if (schema instanceof z.core.$ZodTuple) {
		const { items, rest } = schema._zod.def
		return Array.isArray(value)
			? value.map((item: unknown, index) => {
				const position = items[index] ?? rest
				return position === null || position === undefined ? item : project(position, item)
			})
			: value
	}
	if (schema instanceof z.core.$ZodRecord) {
		const valueType = schema._zod.def.valueType
		return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(valueType, item)])) : value
	}
	if (schema instanceof z.core.$ZodOptional || schema instanceof z.core.$ZodDefault) {
		return value === undefined ? value : project(schema._zod.def.innerType, value)
	}
	if (schema instanceof z.core.$ZodNullable) {
		return value === null ? value : project(schema._zod.def.innerType, value)
	}
	if (schema instanceof z.core.$ZodUnion) {
		for (const option of schema._zod.def.options) {
			const candidate = projectOrRefuse(option, value)
			if (candidate.accepted && z.safeParse(option, candidate.value).success) {
				return candidate.value
			}
		}
		throw new ProjectionRefusedError('no branch of the union accepts the value')
	}
	return value
}

function projectOrRefuse(
	schema: z.core.$ZodType,
	value: unknown,
): { readonly accepted: true; readonly value: unknown } | { readonly accepted: false } {
	try {
		return { accepted: true, value: project(schema, value) }
	} catch (error) {
		if (error instanceof ProjectionRefusedError) {
			return { accepted: false }
		}
		throw error
	}
}
