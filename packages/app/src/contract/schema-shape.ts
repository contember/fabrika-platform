// Reads a zod 4 schema of the contract subset into the `SchemaShape` the artifact carries. The subset is the one
// `@fabrika/check` accepts (`packages/check/CLAUDE.md`); a form outside it is a problem, never dropped silently.

import type { ArrayShape, NumberShape, SchemaShape, StringShape } from '@fabrika/auth-core'
import { z } from 'zod/v4'
import type { Problems } from './problems'

const SUBSET = 'allowed: the supported z subset of packages/check/CLAUDE.md'

type StringFormat = NonNullable<StringShape['format']>

const STRING_FORMATS: ReadonlySet<string> = new Set<StringFormat>(['uuid', 'email', 'url', 'datetime', 'date', 'time', 'duration'])

function isStringFormat(format: string): format is StringFormat {
	return STRING_FORMATS.has(format)
}

/** A schema's shape, or `null` after recording why it has none. */
export function describeSchema(schema: z.core.$ZodType, where: string, problems: Problems): SchemaShape | null {
	if (schema instanceof z.core.$ZodString || schema instanceof z.core.$ZodStringFormat) {
		return describeString(schema, where, problems)
	}
	if (schema instanceof z.core.$ZodNumber) {
		return describeNumber(schema, where, problems)
	}
	if (!hasNoChecks(schema, where, problems)) {
		return null
	}
	if (schema instanceof z.core.$ZodBoolean) {
		if (schema._zod.def.coerce === true) {
			problems.add(where, `a coercing schema is outside the contract subset (${SUBSET})`)
			return null
		}
		return { type: 'boolean' }
	}
	if (schema instanceof z.core.$ZodNull) {
		return { type: 'null' }
	}
	if (schema instanceof z.core.$ZodArray) {
		return describeArray(schema, where, problems)
	}
	if (schema instanceof z.core.$ZodLiteral) {
		return describeLiteral(schema._zod.def.values, where, problems)
	}
	if (schema instanceof z.core.$ZodEnum) {
		return describeEnum(Object.values(schema._zod.def.entries), where, problems)
	}
	if (schema instanceof z.core.$ZodObject) {
		return describeObject(schema, where, problems)
	}
	if (schema instanceof z.core.$ZodTuple) {
		const items = schema._zod.def.items.map((item, index) => describeSchema(item, `${where}[${index}]`, problems))
		const rest = schema._zod.def.rest === null ? null : describeSchema(schema._zod.def.rest, `${where}[…]`, problems)
		return allPresent(items) && (schema._zod.def.rest === null || rest !== null) ? { type: 'tuple', items, rest } : null
	}
	if (schema instanceof z.core.$ZodRecord) {
		const key = describeSchema(schema._zod.def.keyType, `${where} key`, problems)
		const value = describeSchema(schema._zod.def.valueType, `${where} value`, problems)
		return key === null || value === null ? null : { type: 'record', key, value }
	}
	if (schema instanceof z.core.$ZodDiscriminatedUnion && !hasRequiredDiscriminator(schema, where, problems)) {
		return null
	}
	// A discriminated union admits what the plain union of its options admits, once no discriminator has a default.
	if (schema instanceof z.core.$ZodUnion) {
		const options = schema._zod.def.options.map((option, index) => describeSchema(option, `${where} option ${index}`, problems))
		return allPresent(options) ? { type: 'union', options } : null
	}
	// A default makes the value optional to the caller; the framework fills it in from the live schema.
	if (schema instanceof z.core.$ZodOptional || schema instanceof z.core.$ZodDefault) {
		const inner = describeSchema(schema._zod.def.innerType, where, problems)
		return inner === null ? null : { type: 'optional', inner }
	}
	if (schema instanceof z.core.$ZodNullable) {
		const inner = describeSchema(schema._zod.def.innerType, where, problems)
		return inner === null ? null : { type: 'nullable', inner }
	}
	problems.add(where, `a '${schema._zod.def.type}' schema is outside the contract subset (${SUBSET})`)
	return null
}

function describeObject(schema: z.core.$ZodObject, where: string, problems: Problems): SchemaShape | null {
	if (!(schema._zod.def.catchall instanceof z.core.$ZodNever)) {
		problems.add(where, 'the object admits undeclared keys (allowed: z.strictObject({ … }))')
		return null
	}
	const fields: Record<string, SchemaShape> = {}
	let complete = true
	for (const [name, field] of Object.entries(schema._zod.def.shape)) {
		const shape = describeSchema(field, `${where}.${name}`, problems)
		if (shape === null) {
			complete = false
		} else {
			fields[name] = shape
		}
	}
	return complete ? { type: 'object', fields } : null
}

function describeLiteral(values: readonly unknown[], where: string, problems: Problems): SchemaShape | null {
	const shapes: SchemaShape[] = []
	for (const value of values) {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
			shapes.push({ type: 'literal', value })
		} else {
			problems.add(where, `the literal ${String(value)} is not JSON (allowed: a string, number, boolean or null)`)
			return null
		}
	}
	const [only] = shapes
	return shapes.length === 1 && only !== undefined ? only : { type: 'union', options: shapes }
}

function describeEnum(values: readonly unknown[], where: string, problems: Problems): SchemaShape | null {
	const strings: string[] = []
	for (const value of values) {
		if (typeof value !== 'string') {
			problems.add(where, `the enum value ${String(value)} is not a string (allowed: z.enum(['a', 'b']))`)
			return null
		}
		strings.push(value)
	}
	return { type: 'enum', values: strings }
}

function describeString(schema: z.core.$ZodString | z.core.$ZodStringFormat, where: string, problems: Problems): StringShape | null {
	if (schema._zod.def.coerce === true) {
		problems.add(where, `a coercing schema is outside the contract subset (${SUBSET})`)
		return null
	}
	const shape: { -readonly [K in keyof StringShape]: StringShape[K] } = {
		type: 'string',
		format: null,
		minLength: null,
		maxLength: null,
		pattern: null,
		startsWith: null,
		endsWith: null,
		includes: null,
	}
	// `z.uuid()` is itself the format check that `z.string().uuid()` adds to its checks.
	const checks: readonly z.core.$ZodCheck<string>[] = schema instanceof z.core.$ZodCheckStringFormat
		? [schema, ...(schema._zod.def.checks ?? [])]
		: (schema._zod.def.checks ?? [])
	let complete = true
	const setOnce = (field: 'pattern' | 'startsWith' | 'endsWith' | 'includes', value: string, method: string): void => {
		if (shape[field] === null) {
			shape[field] = value
		} else {
			problems.add(where, `the string calls .${method}() twice (allowed: one .${method}() per string)`)
			complete = false
		}
	}
	for (const check of checks) {
		if (isLengthCheck(check)) {
			const bounds = lengthBounds(check, { min: shape.minLength, max: shape.maxLength }, where, problems)
			complete &&= bounds !== null
			shape.minLength = bounds?.min ?? shape.minLength
			shape.maxLength = bounds?.max ?? shape.maxLength
		} else if (check instanceof z.core.$ZodCheckRegex) {
			if (check._zod.def.pattern.flags !== '') {
				problems.add(where, `the pattern /${check._zod.def.pattern.source}/ has flags (allowed: a pattern without flags)`)
				complete = false
			}
			setOnce('pattern', check._zod.def.pattern.source, 'regex')
		} else if (check instanceof z.core.$ZodCheckStartsWith) {
			setOnce('startsWith', check._zod.def.prefix, 'startsWith')
		} else if (check instanceof z.core.$ZodCheckEndsWith) {
			setOnce('endsWith', check._zod.def.suffix, 'endsWith')
		} else if (check instanceof z.core.$ZodCheckIncludes) {
			if (check._zod.def.position !== undefined) {
				problems.add(where, `.includes() with a position is outside the contract subset (allowed: .includes('text'))`)
				complete = false
			}
			setOnce('includes', check._zod.def.includes, 'includes')
		} else if (check instanceof z.core.$ZodCheckStringFormat) {
			const format = check._zod.def.format
			if (!isStringFormat(format) || !hasDefaultOptions(check)) {
				problems.add(where, `the string format '${format}' with these options is outside the contract subset (${SUBSET})`)
				complete = false
			} else if (shape.format !== null) {
				problems.add(where, `the string has two formats, ${shape.format} and ${format} (allowed: one format per string)`)
				complete = false
			} else {
				shape.format = format
			}
		} else {
			problems.add(where, `a '${check._zod.def.check}' check is outside the contract subset (${SUBSET})`)
			complete = false
		}
	}
	return complete && isOrderFree(shape, where, problems) && isSatisfiable(shape.minLength, shape.maxLength, where, problems) ? shape : null
}

/**
 * The artifact keeps a string's checks unordered, so they must not depend on their order. `z.url()` rewrites the
 * value it accepts (`HTTPS://A.CO` → `https://a.co/`), so a check before it and after it see different strings;
 * `startsWith`, `endsWith` and `includes` overlap with what a format admits, so they stay on a plain string.
 */
function isOrderFree(shape: StringShape, where: string, problems: Problems): boolean {
	const affixed = shape.startsWith !== null || shape.endsWith !== null || shape.includes !== null
	if (shape.format === 'url' && (affixed || shape.pattern !== null || shape.minLength !== null || shape.maxLength !== null)) {
		problems.add(where, 'z.url() rewrites the value, so another string check depends on its order (allowed: z.url() with no other check)')
		return false
	}
	if (shape.format !== null && affixed) {
		problems.add(where, `.startsWith(), .endsWith() and .includes() do not combine with the format '${shape.format}' (allowed: one or the other)`)
		return false
	}
	return true
}

/** A discriminator with a default lets a value without it match an option, which the artifact's union cannot say. */
function hasRequiredDiscriminator(schema: z.core.$ZodDiscriminatedUnion, where: string, problems: Problems): boolean {
	const discriminator = schema._zod.def.discriminator
	for (const option of schema._zod.def.options) {
		const field = option instanceof z.core.$ZodObject ? option._zod.def.shape[discriminator] : undefined
		if (field instanceof z.core.$ZodDefault) {
			problems.add(where, `the discriminator '${discriminator}' has a default (allowed: a required literal in every option)`)
			return false
		}
	}
	return true
}

type LengthCheck = z.core.$ZodCheckMinLength | z.core.$ZodCheckMaxLength | z.core.$ZodCheckLengthEquals

function isLengthCheck(check: z.core.$ZodCheck<never>): check is LengthCheck {
	return check instanceof z.core.$ZodCheckMinLength || check instanceof z.core.$ZodCheckMaxLength || check instanceof z.core.$ZodCheckLengthEquals
}

interface Bounds {
	readonly min: number | null
	readonly max: number | null
}

/** The tighter bounds after one length check, or `null` when its value is not a length. */
function lengthBounds(check: LengthCheck, bounds: Bounds, where: string, problems: Problems): Bounds | null {
	const value = check instanceof z.core.$ZodCheckMinLength
		? check._zod.def.minimum
		: check instanceof z.core.$ZodCheckMaxLength
		? check._zod.def.maximum
		: check._zod.def.length
	if (!Number.isSafeInteger(value) || value < 0) {
		problems.add(where, `the length ${value} is not a whole number of at least 0`)
		return null
	}
	const min = check instanceof z.core.$ZodCheckMaxLength ? bounds.min : Math.max(bounds.min ?? 0, value)
	const max = check instanceof z.core.$ZodCheckMinLength ? bounds.max : Math.min(bounds.max ?? value, value)
	return { min, max }
}

function isSatisfiable(min: number | null, max: number | null, where: string, problems: Problems): boolean {
	if (min !== null && max !== null && min > max) {
		problems.add(where, `the minimum ${min} is above the maximum ${max}, so nothing is admitted`)
		return false
	}
	return true
}

/** Options change what a format admits, and the artifact names only the format. */
function hasDefaultOptions(check: z.core.$ZodCheckStringFormat): boolean {
	if (check instanceof z.core.$ZodUUID) {
		return check._zod.def.version === undefined
	}
	if (check instanceof z.core.$ZodEmail) {
		return check._zod.def.pattern?.source === z.regexes.email.source
	}
	if (check instanceof z.core.$ZodURL) {
		return check._zod.def.hostname === undefined && check._zod.def.protocol === undefined
	}
	if (check instanceof z.core.$ZodISODateTime) {
		return !check._zod.def.offset && !check._zod.def.local && check._zod.def.precision === null
	}
	if (check instanceof z.core.$ZodISOTime) {
		return (check._zod.def.precision ?? null) === null
	}
	return true
}

function describeNumber(schema: z.core.$ZodNumber, where: string, problems: Problems): NumberShape | null {
	if (schema._zod.def.coerce === true) {
		problems.add(where, `a coercing schema is outside the contract subset (${SUBSET})`)
		return null
	}
	const shape: { -readonly [K in keyof NumberShape]: NumberShape[K] } = {
		type: 'number',
		int: false,
		min: null,
		exclusiveMin: false,
		max: null,
		exclusiveMax: false,
		multipleOf: null,
	}
	// `z.int()` is itself the format check that `z.number().int()` adds to its checks.
	const checks: readonly z.core.$ZodCheck<never>[] = schema instanceof z.core.$ZodCheckNumberFormat
		? [schema, ...(schema._zod.def.checks ?? [])]
		: (schema._zod.def.checks ?? [])
	let complete = true
	for (const check of checks) {
		if (check instanceof z.core.$ZodCheckNumberFormat && check._zod.def.format === 'safeint') {
			shape.int = true
		} else if (
			(check instanceof z.core.$ZodCheckGreaterThan || check instanceof z.core.$ZodCheckLessThan || check instanceof z.core.$ZodCheckMultipleOf)
			&& !(typeof check._zod.def.value === 'number' && Number.isFinite(check._zod.def.value))
		) {
			problems.add(where, `the bound ${String(check._zod.def.value)} is not a finite number`)
			complete = false
		} else if (check instanceof z.core.$ZodCheckGreaterThan && typeof check._zod.def.value === 'number') {
			const value = check._zod.def.value
			const exclusive = !check._zod.def.inclusive
			if (shape.min === null || value > shape.min || (value === shape.min && exclusive)) {
				shape.min = value
				shape.exclusiveMin = exclusive
			}
		} else if (check instanceof z.core.$ZodCheckLessThan && typeof check._zod.def.value === 'number') {
			const value = check._zod.def.value
			const exclusive = !check._zod.def.inclusive
			if (shape.max === null || value < shape.max || (value === shape.max && exclusive)) {
				shape.max = value
				shape.exclusiveMax = exclusive
			}
		} else if (check instanceof z.core.$ZodCheckMultipleOf && typeof check._zod.def.value === 'number' && shape.multipleOf === null) {
			if (check._zod.def.value <= 0) {
				problems.add(where, `.multipleOf(${check._zod.def.value}) is not a positive step`)
				complete = false
			}
			shape.multipleOf = check._zod.def.value
		} else {
			problems.add(where, `a '${check._zod.def.check}' check is outside the contract subset (${SUBSET}; one .multipleOf() per number)`)
			complete = false
		}
	}
	if (shape.min !== null && shape.max !== null && (shape.min > shape.max || (shape.min === shape.max && (shape.exclusiveMin || shape.exclusiveMax)))) {
		problems.add(where, `the bounds ${shape.min} and ${shape.max} admit no number`)
		return null
	}
	return complete ? shape : null
}

function describeArray(schema: z.core.$ZodArray, where: string, problems: Problems): ArrayShape | null {
	const items = describeSchema(schema._zod.def.element, `${where}[]`, problems)
	let minItems: number | null = null
	let maxItems: number | null = null
	let complete = items !== null
	for (const check of schema._zod.def.checks ?? []) {
		if (isLengthCheck(check)) {
			const bounds = lengthBounds(check, { min: minItems, max: maxItems }, where, problems)
			complete &&= bounds !== null
			minItems = bounds?.min ?? minItems
			maxItems = bounds?.max ?? maxItems
		} else {
			problems.add(where, `a '${check._zod.def.check}' check is outside the contract subset (${SUBSET})`)
			complete = false
		}
	}
	return complete && items !== null && isSatisfiable(minItems, maxItems, where, problems) ? { type: 'array', items, minItems, maxItems } : null
}

function hasNoChecks(schema: z.core.$ZodType, where: string, problems: Problems): boolean {
	if (schema instanceof z.core.$ZodArray) {
		return true
	}
	const [check] = schema._zod.def.checks ?? []
	if (check !== undefined) {
		problems.add(where, `a '${check._zod.def.check}' check is outside the contract subset (${SUBSET})`)
		return false
	}
	return true
}

function allPresent<T>(values: readonly (T | null)[]): values is readonly T[] {
	return values.every((value) => value !== null)
}
