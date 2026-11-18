// One step of a `z` chain of the contract subset, replayed against zod itself: a factory, or a method on a receiver that
// an earlier step built. `DataSchema` and the static contract reader both build zod only through here, so a recorded
// chain and the evaluated module hold the same schema.

import { z } from 'zod/v4'

/** A plain argument of a step, with every schema in it already zod. */
export type ReplayArg =
	| string
	| number
	| boolean
	| null
	| RegExp
	| z.ZodType
	| Unreadable
	| readonly ReplayArg[]
	| { readonly [key: string]: ReplayArg }

/** An argument a reader of source read that is no value of the subset (a builder call, say): refused by its kind. */
export class Unreadable {
	readonly kind: string

	constructor(kind: string) {
		this.kind = kind
		Object.freeze(this)
	}
}

/** `z.<factory>(…)`, `z.iso.<factory>(…)` or `.<method>(…)` on a receiver. */
export type ReplayStep = { readonly factory: string; readonly iso: boolean } | { readonly method: string; readonly receiver: z.ZodType }

export const SCHEMA_SUBSET = 'a schema of the supported z subset (packages/check/CLAUDE.md)'

/** A step zod would refuse, or one outside the contract subset: what is wrong and what is allowed there. */
export class SchemaRefusal extends Error {
	override readonly name = 'SchemaRefusal'
	readonly allowed: string

	constructor(message: string, allowed: string) {
		super(message)
		this.allowed = allowed
	}
}

/** The zod schema `step` builds from `args`; a step outside the subset, or one zod refuses, throws a `SchemaRefusal`. */
export function replayStep(step: ReplayStep, args: readonly ReplayArg[]): z.ZodType {
	try {
		return 'factory' in step ? (step.iso ? isoFormat(step.factory, args) : factory(step.factory, args)) : method(step.method, step.receiver, args)
	} catch (error) {
		if (error instanceof SchemaRefusal) {
			throw error
		}
		// zod refuses some arguments while building, e.g. `.pick()` of a key the object does not have.
		const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : 'zod refused the schema'
		throw new SchemaRefusal(`zod refuses this schema: ${message}`, SCHEMA_SUBSET)
	}
}

function factory(name: string, args: readonly ReplayArg[]): z.ZodType {
	const call = `z.${name}()`
	switch (name) {
		case 'string':
			return z.string(messageParams(call, only(call, args)))
		case 'number':
			return z.number(messageParams(call, only(call, args)))
		case 'int':
			return z.int(messageParams(call, only(call, args)))
		case 'boolean':
			return z.boolean(messageParams(call, only(call, args)))
		case 'null':
			return z.null(messageParams(call, only(call, args)))
		case 'uuid':
			return z.uuid(uuidParams(call, only(call, args)))
		case 'email':
			return z.email(messageParams(call, only(call, args)))
		case 'url':
			return z.url(messageParams(call, only(call, args)))
		case 'literal': {
			const [value, params] = between(call, args, 1, 2)
			const literal = literalValues(call, value)
			return Array.isArray(literal) ? z.literal(literal, messageParams(call, params)) : z.literal(literal, messageParams(call, params))
		}
		case 'enum': {
			const [values, params] = between(call, args, 1, 2)
			const entries = enumEntries(call, values)
			return Array.isArray(entries) ? z.enum(entries, messageParams(call, params)) : z.enum(entries, messageParams(call, params))
		}
		case 'strictObject': {
			const [shape, params] = between(call, args, 1, 2)
			return z.strictObject(schemaShape(call, shape), messageParams(call, params))
		}
		case 'array': {
			const [element, params] = between(call, args, 1, 2)
			return z.array(schema(call, element), messageParams(call, params))
		}
		case 'tuple':
			return tuple(call, args)
		case 'union': {
			const [options, params] = between(call, args, 1, 2)
			return z.union(schemaList(call, options), messageParams(call, params))
		}
		case 'discriminatedUnion': {
			const [discriminator, options, params] = between(call, args, 2, 3)
			const [first, ...rest] = schemaList(call, options).map((option) => objectSchema(call, option))
			if (first === undefined) {
				throw new SchemaRefusal(`${call} has no option`, 'z.discriminatedUnion(<key>, [z.strictObject({ … }), …])')
			}
			return z.discriminatedUnion(text(call, discriminator), [first, ...rest], messageParams(call, params))
		}
		case 'record': {
			const [key, value, params] = between(call, args, 2, 3)
			return z.record(recordKey(call, schema(call, key)), schema(call, value), messageParams(call, params))
		}
		case 'optional':
			return z.optional(schema(call, exactly(call, args, 1)[0]))
		case 'nullable':
			return z.nullable(schema(call, exactly(call, args, 1)[0]))
		default:
			throw new SchemaRefusal(`'${name}' is not in the supported schema subset`, SCHEMA_SUBSET)
	}
}

function isoFormat(name: string, args: readonly ReplayArg[]): z.ZodType {
	const call = `z.iso.${name}()`
	switch (name) {
		case 'date':
			return z.iso.date(messageParams(call, only(call, args)))
		case 'datetime':
			return z.iso.datetime(datetimeParams(call, only(call, args)))
		case 'time':
			return z.iso.time(timeParams(call, only(call, args)))
		case 'duration':
			return z.iso.duration(messageParams(call, only(call, args)))
		default:
			throw new SchemaRefusal(`'iso.${name}' is not in the supported schema subset`, SCHEMA_SUBSET)
	}
}

function method(name: string, receiver: z.ZodType, args: readonly ReplayArg[]): z.ZodType {
	const call = `.${name}()`
	switch (name) {
		case 'min':
		case 'max':
		case 'length': {
			const [bound, params] = between(call, args, 1, 2)
			const value = number(call, bound)
			const message = messageParams(call, params)
			if (receiver instanceof z.ZodString || receiver instanceof z.ZodStringFormat) {
				return name === 'min' ? receiver.min(value, message) : name === 'max' ? receiver.max(value, message) : receiver.length(value, message)
			}
			if (receiver instanceof z.ZodArray) {
				return name === 'min' ? receiver.min(value, message) : name === 'max' ? receiver.max(value, message) : receiver.length(value, message)
			}
			if (receiver instanceof z.ZodNumber && name !== 'length') {
				return name === 'min' ? receiver.min(value, message) : receiver.max(value, message)
			}
			throw unsupported(call, receiver)
		}
		case 'nonempty': {
			const message = messageParams(call, only(call, args))
			if (receiver instanceof z.ZodString || receiver instanceof z.ZodStringFormat || receiver instanceof z.ZodArray) {
				return receiver.nonempty(message)
			}
			throw unsupported(call, receiver)
		}
		case 'email':
		case 'url':
		case 'uuid': {
			const params = only(call, args)
			if (!(receiver instanceof z.ZodString)) {
				throw unsupported(call, receiver)
			}
			return name === 'email'
				? receiver.email(messageParams(call, params))
				: name === 'url'
				? receiver.url(messageParams(call, params))
				: receiver.uuid(uuidParams(call, params))
		}
		case 'startsWith':
		case 'endsWith':
		case 'includes':
		case 'regex': {
			const [argument, params] = between(call, args, 1, 2)
			if (!(receiver instanceof z.ZodString || receiver instanceof z.ZodStringFormat)) {
				throw unsupported(call, receiver)
			}
			switch (name) {
				case 'startsWith':
					return receiver.startsWith(text(call, argument), messageParams(call, params))
				case 'endsWith':
					return receiver.endsWith(text(call, argument), messageParams(call, params))
				case 'includes':
					return receiver.includes(text(call, argument), includesParams(call, params))
				default:
					return receiver.regex(regex(call, argument), messageParams(call, params))
			}
		}
		case 'int':
		case 'positive':
		case 'negative':
		case 'nonnegative':
		case 'nonpositive': {
			const message = messageParams(call, only(call, args))
			if (!(receiver instanceof z.ZodNumber)) {
				throw unsupported(call, receiver)
			}
			switch (name) {
				case 'int':
					return receiver.int(message)
				case 'positive':
					return receiver.positive(message)
				case 'negative':
					return receiver.negative(message)
				case 'nonnegative':
					return receiver.nonnegative(message)
				default:
					return receiver.nonpositive(message)
			}
		}
		case 'gt':
		case 'gte':
		case 'lt':
		case 'lte':
		case 'multipleOf': {
			const [bound, params] = between(call, args, 1, 2)
			const value = number(call, bound)
			const message = messageParams(call, params)
			if (!(receiver instanceof z.ZodNumber)) {
				throw unsupported(call, receiver)
			}
			switch (name) {
				case 'gt':
					return receiver.gt(value, message)
				case 'gte':
					return receiver.gte(value, message)
				case 'lt':
					return receiver.lt(value, message)
				case 'lte':
					return receiver.lte(value, message)
				default:
					return receiver.multipleOf(value, message)
			}
		}
		case 'optional':
			exactly(call, args, 0)
			return receiver.optional()
		case 'nullable':
			exactly(call, args, 0)
			return receiver.nullable()
		case 'nullish':
			exactly(call, args, 0)
			return receiver.nullish()
		case 'array':
			exactly(call, args, 0)
			return receiver.array()
		case 'default':
			return receiver.default(plain(call, exactly(call, args, 1)[0]))
		case 'describe':
			return receiver.describe(text(call, exactly(call, args, 1)[0]))
		case 'or':
			return receiver.or(schema(call, exactly(call, args, 1)[0]))
		case 'extend':
		case 'pick':
		case 'omit':
		case 'partial': {
			if (!(receiver instanceof z.ZodObject)) {
				throw unsupported(call, receiver)
			}
			if (name === 'extend') {
				return receiver.extend(schemaShape(call, exactly(call, args, 1)[0]))
			}
			if (name === 'partial') {
				const [mask] = between(call, args, 0, 1)
				return mask === undefined ? receiver.partial() : receiver.partial(keyMask(call, mask))
			}
			const mask = keyMask(call, exactly(call, args, 1)[0])
			return name === 'pick' ? receiver.pick(mask) : receiver.omit(mask)
		}
		case 'exclude':
		case 'extract': {
			// Outside the contract subset, which no contract module calls: application code narrows an enum with them.
			const [keys, params] = between(call, args, 1, 2)
			if (!(receiver instanceof z.ZodEnum)) {
				throw unsupported(call, receiver)
			}
			const names = textList(call, keys)
			return name === 'exclude' ? receiver.exclude(names, messageParams(call, params)) : receiver.extract(names, messageParams(call, params))
		}
		default:
			throw new SchemaRefusal(`'${name}' is not in the supported schema subset`, SCHEMA_SUBSET)
	}
}

function tuple(call: string, args: readonly ReplayArg[]): z.ZodType {
	const [items, second, third] = between(call, args, 1, 3)
	const [first, ...rest] = schemaList(call, items)
	const restSchema = second instanceof z.ZodType ? second : undefined
	const params = messageParams(call, restSchema === undefined ? second : third)
	if (restSchema === undefined && third !== undefined) {
		throw new SchemaRefusal(`${call} takes its items, an optional rest schema and options`, 'z.tuple([<schemas>], <rest schema>)')
	}
	if (first === undefined) {
		if (restSchema !== undefined) {
			throw new SchemaRefusal(`${call} with a rest and no item`, 'z.array(<schema>)')
		}
		return z.tuple([], params)
	}
	return restSchema === undefined ? z.tuple([first, ...rest], params) : z.tuple([first, ...rest], restSchema, params)
}

// ── Arguments ───────────────────────────────────────────────────────────────────────────────────

type Entries = { readonly [key: string]: ReplayArg }

/** What the literal subset calls an argument's kind, for a refusal that names it. */
function kindOf(value: ReplayArg): string {
	if (value === null) {
		return 'null'
	}
	if (value instanceof RegExp) {
		return 'regex'
	}
	if (value instanceof z.ZodType) {
		return 'schema'
	}
	if (value instanceof Unreadable) {
		return value.kind
	}
	if (Array.isArray(value)) {
		return 'array'
	}
	return typeof value
}

function entriesOf(value: ReplayArg | undefined): Entries | undefined {
	if (
		typeof value !== 'object' || value === null || value instanceof RegExp || value instanceof z.ZodType || value instanceof Unreadable || isList(value)
	) {
		return undefined
	}
	const prototype: unknown = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null ? value : undefined
}

function isList(value: ReplayArg): value is readonly ReplayArg[] {
	return Array.isArray(value)
}

function listOf(value: ReplayArg | undefined): readonly ReplayArg[] | undefined {
	return value !== undefined && isList(value) ? value : undefined
}

function between(call: string, args: readonly ReplayArg[], min: number, max: number): readonly (ReplayArg | undefined)[] {
	if (args.length < min || args.length > max) {
		const count = min === max ? `${min}` : `${min} to ${max}`
		throw new SchemaRefusal(`${call} takes ${count} arguments, not ${args.length}`, SCHEMA_SUBSET)
	}
	return Array.from({ length: max }, (_, index) => args[index])
}

function exactly(call: string, args: readonly ReplayArg[], count: number): readonly (ReplayArg | undefined)[] {
	return between(call, args, count, count)
}

/** The one optional argument of a call that takes only options. */
function only(call: string, args: readonly ReplayArg[]): ReplayArg | undefined {
	return between(call, args, 0, 1)[0]
}

function expected(call: string, what: string, value: ReplayArg | undefined): SchemaRefusal {
	return new SchemaRefusal(`${call} takes ${what}${value === undefined ? '' : `, not a ${kindOf(value)}`}`, SCHEMA_SUBSET)
}

function schema(call: string, value: ReplayArg | undefined): z.ZodType {
	if (!(value instanceof z.ZodType)) {
		throw expected(call, 'a schema', value)
	}
	return value
}

function number(call: string, value: ReplayArg | undefined): number {
	if (typeof value !== 'number') {
		throw expected(call, 'a number', value)
	}
	return value
}

function text(call: string, value: ReplayArg | undefined): string {
	if (typeof value !== 'string') {
		throw expected(call, 'a string', value)
	}
	return value
}

function textList(call: string, value: ReplayArg | undefined): string[] {
	const items = listOf(value)
	if (items === undefined) {
		throw expected(call, 'an array of strings', value)
	}
	return items.map((item) => text(call, item))
}

function regex(call: string, value: ReplayArg | undefined): RegExp {
	if (!(value instanceof RegExp)) {
		throw expected(call, 'a regular expression literal', value)
	}
	return value
}

function schemaList(call: string, value: ReplayArg | undefined): z.ZodType[] {
	const items = listOf(value)
	if (items === undefined) {
		throw expected(call, 'an array of schemas', value)
	}
	return items.map((item) => schema(call, item))
}

function schemaShape(call: string, value: ReplayArg | undefined): Record<string, z.ZodType> {
	const entries = entriesOf(value)
	if (entries === undefined) {
		throw expected(call, 'an object of schemas', value)
	}
	return Object.fromEntries(Object.entries(entries).map(([key, field]) => [key, schema(call, field)]))
}

function keyMask(call: string, value: ReplayArg | undefined): Record<string, true> {
	const entries = entriesOf(value)
	if (entries === undefined || Object.values(entries).some((entry) => entry !== true)) {
		throw expected(call, 'an object of keys set to true', value)
	}
	return Object.fromEntries(Object.keys(entries).map((key): [string, true] => [key, true]))
}

function objectSchema(call: string, option: z.ZodType): z.ZodObject {
	if (!(option instanceof z.ZodObject)) {
		throw new SchemaRefusal(`${call} takes object options`, 'z.discriminatedUnion(<key>, [z.strictObject({ … }), …])')
	}
	return option
}

function recordKey(call: string, key: z.ZodType): z.ZodString | z.ZodStringFormat | z.ZodEnum {
	if (key instanceof z.ZodString || key instanceof z.ZodStringFormat || key instanceof z.ZodEnum) {
		return key
	}
	throw new SchemaRefusal(`${call} takes a string or enum key`, 'z.record(z.string(), <schema>)')
}

type Primitive = string | number | boolean | null

function primitive(call: string, value: ReplayArg | undefined): Primitive {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
		return value
	}
	throw expected(call, 'a string, number, boolean or null', value)
}

function literalValues(call: string, value: ReplayArg | undefined): Primitive | Primitive[] {
	const items = listOf(value)
	return items === undefined ? primitive(call, value) : items.map((item) => primitive(call, item))
}

function enumEntries(call: string, value: ReplayArg | undefined): string[] | Record<string, string | number> {
	const items = listOf(value)
	if (items !== undefined) {
		return items.map((item) => text(call, item))
	}
	const entries = entriesOf(value)
	if (entries !== undefined) {
		return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, typeof entry === 'number' ? entry : text(call, entry)]))
	}
	throw expected(call, 'an array of strings or an object', value)
}

/** A value with no schema in it, as the evaluated literal would be. */
function plain(call: string, value: ReplayArg | undefined): unknown {
	const items = listOf(value)
	if (items !== undefined) {
		return items.map((item) => plain(call, item))
	}
	const entries = entriesOf(value)
	if (entries !== undefined) {
		return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, plain(call, entry)]))
	}
	return primitive(call, value)
}

// ── Options ─────────────────────────────────────────────────────────────────────────────────────

/** An error message changes no shape; `error` and `message` are the only options every step takes. */
interface MessageParams {
	message?: string
	error?: string
}

const MESSAGE_KEYS = ['message', 'error'] as const

function options(call: string, value: ReplayArg | undefined, keys: readonly string[]): Entries | string | undefined {
	if (value === undefined || typeof value === 'string') {
		return value
	}
	const entries = entriesOf(value)
	if (entries === undefined) {
		throw expected(call, 'an error message or an options object', value)
	}
	for (const key of Object.keys(entries)) {
		if (!keys.includes(key)) {
			throw new SchemaRefusal(`'${key}' is not an option the contract reads for ${call}`, `options among ${keys.join(', ')}`)
		}
	}
	return entries
}

function messageFields(call: string, entries: Entries): MessageParams {
	const params: MessageParams = {}
	const message = entries['message']
	const error = entries['error']
	if (message !== undefined) {
		params.message = text(call, message)
	}
	if (error !== undefined) {
		params.error = text(call, error)
	}
	return params
}

function messageParams(call: string, value: ReplayArg | undefined): string | MessageParams | undefined {
	const read = options(call, value, MESSAGE_KEYS)
	return read === undefined || typeof read === 'string' ? read : messageFields(call, read)
}

const UUID_VERSIONS = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'] as const

type UuidVersion = (typeof UUID_VERSIONS)[number]

function isUuidVersion(version: string): version is UuidVersion {
	return UUID_VERSIONS.some((known) => known === version)
}

function uuidParams(call: string, value: ReplayArg | undefined): string | (MessageParams & { version?: UuidVersion }) | undefined {
	const read = options(call, value, [...MESSAGE_KEYS, 'version'])
	if (read === undefined || typeof read === 'string') {
		return read
	}
	const params: MessageParams & { version?: UuidVersion } = messageFields(call, read)
	const version = read['version']
	if (version !== undefined) {
		const name = text(call, version)
		if (!isUuidVersion(name)) {
			throw new SchemaRefusal(`'${name}' is not a UUID version`, `one of ${UUID_VERSIONS.join(', ')}`)
		}
		params.version = name
	}
	return params
}

function precision(call: string, value: ReplayArg): number | null {
	return value === null ? null : number(call, value)
}

function datetimeParams(
	call: string,
	value: ReplayArg | undefined,
): string | (MessageParams & { offset?: boolean; local?: boolean; precision?: number | null }) | undefined {
	const read = options(call, value, [...MESSAGE_KEYS, 'offset', 'local', 'precision'])
	if (read === undefined || typeof read === 'string') {
		return read
	}
	const params: MessageParams & { offset?: boolean; local?: boolean; precision?: number | null } = messageFields(call, read)
	const offset = read['offset']
	const local = read['local']
	const digits = read['precision']
	if (offset !== undefined) {
		params.offset = flag(call, offset)
	}
	if (local !== undefined) {
		params.local = flag(call, local)
	}
	if (digits !== undefined) {
		params.precision = precision(call, digits)
	}
	return params
}

function timeParams(call: string, value: ReplayArg | undefined): string | (MessageParams & { precision?: number | null }) | undefined {
	const read = options(call, value, [...MESSAGE_KEYS, 'precision'])
	if (read === undefined || typeof read === 'string') {
		return read
	}
	const params: MessageParams & { precision?: number | null } = messageFields(call, read)
	const digits = read['precision']
	if (digits !== undefined) {
		params.precision = precision(call, digits)
	}
	return params
}

/** `.includes()` takes its options only as an object. */
function includesParams(call: string, value: ReplayArg | undefined): (MessageParams & { position?: number }) | undefined {
	const read = options(call, value, [...MESSAGE_KEYS, 'position'])
	if (typeof read === 'string') {
		throw new SchemaRefusal(`${call} takes its options as an object`, "{ message: '…' }")
	}
	if (read === undefined) {
		return undefined
	}
	const params: MessageParams & { position?: number } = messageFields(call, read)
	const position = read['position']
	if (position !== undefined) {
		params.position = number(call, position)
	}
	return params
}

function flag(call: string, value: ReplayArg): boolean {
	if (typeof value !== 'boolean') {
		throw expected(call, 'a boolean option', value)
	}
	return value
}

function unsupported(call: string, receiver: z.ZodType): SchemaRefusal {
	return new SchemaRefusal(`${call} is not a method of a ${receiver._zod.def.type} schema in the contract subset`, SCHEMA_SUBSET)
}
