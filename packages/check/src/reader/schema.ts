// Builds the real zod schema a `z` chain of the contract subset denotes, one factory or method at a time. Each step
// calls zod itself, so `@fabrika/app`'s `describeContract` reads exactly the schema the evaluated module would hold.

import { z } from 'zod/v4'
import type { LiteralValue } from './value'

export type SchemaStep = { readonly factory: string; readonly iso: boolean } | { readonly method: string; readonly receiver: z.ZodType | undefined }

export type BuiltSchema = { readonly ok: true; readonly schema: z.ZodType } | {
	readonly ok: false
	readonly message: string
	readonly allowed: string
}

const SUBSET = 'a schema of the supported z subset (packages/check/CLAUDE.md)'

/** A refused step; thrown inside this module only, and returned as a problem by `buildSchema`. */
class Refusal {
	readonly message: string
	readonly allowed: string

	constructor(message: string, allowed: string) {
		this.message = message
		this.allowed = allowed
	}
}

export function buildSchema(step: SchemaStep, args: readonly LiteralValue[]): BuiltSchema {
	try {
		const schema = 'factory' in step
			? (step.iso ? isoFormat(step.factory, args) : factory(step.factory, args))
			: method(step.method, step.receiver, args)
		return { ok: true, schema }
	} catch (error) {
		if (error instanceof Refusal) {
			return { ok: false, message: error.message, allowed: error.allowed }
		}
		// zod refuses some arguments while building, e.g. `.pick()` of a key the object does not have.
		const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : 'zod refused the schema'
		return { ok: false, message: `zod refuses this schema: ${message}`, allowed: SUBSET }
	}
}

function factory(name: string, args: readonly LiteralValue[]): z.ZodType {
	const call = `z.${name}()`
	switch (name) {
		case 'string':
			return z.string(messageParams(call, only(call, args, 0)))
		case 'number':
			return z.number(messageParams(call, only(call, args, 0)))
		case 'int':
			return z.int(messageParams(call, only(call, args, 0)))
		case 'boolean':
			return z.boolean(messageParams(call, only(call, args, 0)))
		case 'null':
			return z.null(messageParams(call, only(call, args, 0)))
		case 'uuid':
			return z.uuid(uuidParams(call, only(call, args, 0)))
		case 'email':
			return z.email(messageParams(call, only(call, args, 0)))
		case 'url':
			return z.url(messageParams(call, only(call, args, 0)))
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
				throw new Refusal(`${call} has no option`, 'z.discriminatedUnion(<key>, [z.strictObject({ … }), …])')
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
			throw new Refusal(`'${name}' is not in the supported schema subset`, SUBSET)
	}
}

function isoFormat(name: string, args: readonly LiteralValue[]): z.ZodType {
	const call = `z.iso.${name}()`
	switch (name) {
		case 'date':
			return z.iso.date(messageParams(call, only(call, args, 0)))
		case 'datetime':
			return z.iso.datetime(datetimeParams(call, only(call, args, 0)))
		case 'time':
			return z.iso.time(timeParams(call, only(call, args, 0)))
		case 'duration':
			return z.iso.duration(messageParams(call, only(call, args, 0)))
		default:
			throw new Refusal(`'iso.${name}' is not in the supported schema subset`, SUBSET)
	}
}

function method(name: string, receiver: z.ZodType | undefined, args: readonly LiteralValue[]): z.ZodType {
	const call = `.${name}()`
	if (receiver === undefined) {
		throw new Refusal('a schema method without a schema', SUBSET)
	}
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
			const message = messageParams(call, only(call, args, 0))
			if (receiver instanceof z.ZodString || receiver instanceof z.ZodStringFormat || receiver instanceof z.ZodArray) {
				return receiver.nonempty(message)
			}
			throw unsupported(call, receiver)
		}
		case 'email':
		case 'url':
		case 'uuid': {
			const params = only(call, args, 0)
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
			const message = messageParams(call, only(call, args, 0))
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
		default:
			throw new Refusal(`'${name}' is not in the supported schema subset`, SUBSET)
	}
}

function tuple(call: string, args: readonly LiteralValue[]): z.ZodType {
	const [items, second, third] = between(call, args, 1, 3)
	const [first, ...rest] = schemaList(call, items)
	const restSchema = second?.kind === 'schema' ? second.schema : undefined
	const params = messageParams(call, restSchema === undefined ? second : third)
	if (restSchema === undefined && third !== undefined) {
		throw new Refusal(`${call} takes its items, an optional rest schema and options`, 'z.tuple([<schemas>], <rest schema>)')
	}
	if (first === undefined) {
		if (restSchema !== undefined) {
			throw new Refusal(`${call} with a rest and no item`, 'z.array(<schema>)')
		}
		return z.tuple([], params)
	}
	return restSchema === undefined ? z.tuple([first, ...rest], params) : z.tuple([first, ...rest], restSchema, params)
}

// ── Arguments ───────────────────────────────────────────────────────────────────────────────────

function between(call: string, args: readonly LiteralValue[], min: number, max: number): readonly (LiteralValue | undefined)[] {
	if (args.length < min || args.length > max) {
		const count = min === max ? `${min}` : `${min} to ${max}`
		throw new Refusal(`${call} takes ${count} arguments, not ${args.length}`, SUBSET)
	}
	return Array.from({ length: max }, (_, index) => args[index])
}

function exactly(call: string, args: readonly LiteralValue[], count: number): readonly (LiteralValue | undefined)[] {
	return between(call, args, count, count)
}

/** The one optional argument of a call that takes only options. */
function only(call: string, args: readonly LiteralValue[], required: 0): LiteralValue | undefined {
	return between(call, args, required, 1)[0]
}

function expected(call: string, what: string, value: LiteralValue | undefined): Refusal {
	return new Refusal(`${call} takes ${what}${value === undefined ? '' : `, not a ${value.kind}`}`, SUBSET)
}

function schema(call: string, value: LiteralValue | undefined): z.ZodType {
	if (value?.kind !== 'schema') {
		throw expected(call, 'a schema', value)
	}
	return value.schema
}

function number(call: string, value: LiteralValue | undefined): number {
	if (value?.kind !== 'number') {
		throw expected(call, 'a number', value)
	}
	return value.value
}

function text(call: string, value: LiteralValue | undefined): string {
	if (value?.kind !== 'string') {
		throw expected(call, 'a string', value)
	}
	return value.value
}

function regex(call: string, value: LiteralValue | undefined): RegExp {
	if (value?.kind !== 'regex') {
		throw expected(call, 'a regular expression literal', value)
	}
	return value.value
}

function schemaList(call: string, value: LiteralValue | undefined): z.ZodType[] {
	if (value?.kind !== 'array') {
		throw expected(call, 'an array of schemas', value)
	}
	return value.items.map((item) => schema(call, item))
}

function schemaShape(call: string, value: LiteralValue | undefined): Record<string, z.ZodType> {
	if (value?.kind !== 'object') {
		throw expected(call, 'an object of schemas', value)
	}
	return Object.fromEntries([...value.entries].map(([key, field]) => [key, schema(call, field)]))
}

function keyMask(call: string, value: LiteralValue | undefined): Record<string, true> {
	if (value?.kind !== 'object' || [...value.entries.values()].some((entry) => entry.kind !== 'boolean' || !entry.value)) {
		throw expected(call, 'an object of keys set to true', value)
	}
	return Object.fromEntries([...value.entries.keys()].map((key): [string, true] => [key, true]))
}

function objectSchema(call: string, option: z.ZodType): z.ZodObject {
	if (!(option instanceof z.ZodObject)) {
		throw new Refusal(`${call} takes object options`, 'z.discriminatedUnion(<key>, [z.strictObject({ … }), …])')
	}
	return option
}

function recordKey(call: string, key: z.ZodType): z.ZodString | z.ZodStringFormat | z.ZodEnum {
	if (key instanceof z.ZodString || key instanceof z.ZodStringFormat || key instanceof z.ZodEnum) {
		return key
	}
	throw new Refusal(`${call} takes a string or enum key`, 'z.record(z.string(), <schema>)')
}

type Primitive = string | number | boolean | null

function primitive(call: string, value: LiteralValue | undefined): Primitive {
	switch (value?.kind) {
		case 'string':
		case 'number':
		case 'boolean':
			return value.value
		case 'null':
			return null
		default:
			throw expected(call, 'a string, number, boolean or null', value)
	}
}

function literalValues(call: string, value: LiteralValue | undefined): Primitive | Primitive[] {
	return value?.kind === 'array' ? value.items.map((item) => primitive(call, item)) : primitive(call, value)
}

function enumEntries(call: string, value: LiteralValue | undefined): string[] | Record<string, string | number> {
	if (value?.kind === 'array') {
		return value.items.map((item) => text(call, item))
	}
	if (value?.kind === 'object') {
		return Object.fromEntries([...value.entries].map(([key, entry]) => [key, entry.kind === 'number' ? entry.value : text(call, entry)]))
	}
	throw expected(call, 'an array of strings or an object', value)
}

/** A value with no schema or builder in it, as the evaluated literal would be. */
function plain(call: string, value: LiteralValue | undefined): unknown {
	switch (value?.kind) {
		case 'array':
			return value.items.map((item) => plain(call, item))
		case 'object':
			return Object.fromEntries([...value.entries].map(([key, entry]) => [key, plain(call, entry)]))
		default:
			return primitive(call, value)
	}
}

// ── Options ─────────────────────────────────────────────────────────────────────────────────────

/** An error message changes no shape; `error` and `message` are the only options every step takes. */
interface MessageParams {
	message?: string
	error?: string
}

const MESSAGE_KEYS = ['message', 'error'] as const

function options(call: string, value: LiteralValue | undefined, keys: readonly string[]): ReadonlyMap<string, LiteralValue> | string | undefined {
	if (value === undefined || value.kind === 'string') {
		return value?.value
	}
	if (value.kind !== 'object') {
		throw expected(call, 'an error message or an options object', value)
	}
	for (const key of value.entries.keys()) {
		if (!keys.includes(key)) {
			throw new Refusal(`'${key}' is not an option the contract reads for ${call}`, `options among ${keys.join(', ')}`)
		}
	}
	return value.entries
}

function messageFields(call: string, entries: ReadonlyMap<string, LiteralValue>): MessageParams {
	const params: MessageParams = {}
	const message = entries.get('message')
	const error = entries.get('error')
	if (message !== undefined) {
		params.message = text(call, message)
	}
	if (error !== undefined) {
		params.error = text(call, error)
	}
	return params
}

function messageParams(call: string, value: LiteralValue | undefined): string | MessageParams | undefined {
	const read = options(call, value, MESSAGE_KEYS)
	return read === undefined || typeof read === 'string' ? read : messageFields(call, read)
}

const UUID_VERSIONS = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'] as const

type UuidVersion = (typeof UUID_VERSIONS)[number]

function isUuidVersion(version: string): version is UuidVersion {
	return UUID_VERSIONS.some((known) => known === version)
}

function uuidParams(call: string, value: LiteralValue | undefined): string | (MessageParams & { version?: UuidVersion }) | undefined {
	const read = options(call, value, [...MESSAGE_KEYS, 'version'])
	if (read === undefined || typeof read === 'string') {
		return read
	}
	const params: MessageParams & { version?: UuidVersion } = messageFields(call, read)
	const version = read.get('version')
	if (version !== undefined) {
		const name = text(call, version)
		if (!isUuidVersion(name)) {
			throw new Refusal(`'${name}' is not a UUID version`, `one of ${UUID_VERSIONS.join(', ')}`)
		}
		params.version = name
	}
	return params
}

function precision(call: string, value: LiteralValue): number | null {
	return value.kind === 'null' ? null : number(call, value)
}

function datetimeParams(
	call: string,
	value: LiteralValue | undefined,
): string | (MessageParams & { offset?: boolean; local?: boolean; precision?: number | null }) | undefined {
	const read = options(call, value, [...MESSAGE_KEYS, 'offset', 'local', 'precision'])
	if (read === undefined || typeof read === 'string') {
		return read
	}
	const params: MessageParams & { offset?: boolean; local?: boolean; precision?: number | null } = messageFields(call, read)
	const offset = read.get('offset')
	const local = read.get('local')
	const digits = read.get('precision')
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

function timeParams(call: string, value: LiteralValue | undefined): string | (MessageParams & { precision?: number | null }) | undefined {
	const read = options(call, value, [...MESSAGE_KEYS, 'precision'])
	if (read === undefined || typeof read === 'string') {
		return read
	}
	const params: MessageParams & { precision?: number | null } = messageFields(call, read)
	const digits = read.get('precision')
	if (digits !== undefined) {
		params.precision = precision(call, digits)
	}
	return params
}

/** `.includes()` takes its options only as an object. */
function includesParams(call: string, value: LiteralValue | undefined): (MessageParams & { position?: number }) | undefined {
	const read = options(call, value, [...MESSAGE_KEYS, 'position'])
	if (typeof read === 'string') {
		throw new Refusal(`${call} takes its options as an object`, "{ message: '…' }")
	}
	if (read === undefined) {
		return undefined
	}
	const params: MessageParams & { position?: number } = messageFields(call, read)
	const position = read.get('position')
	if (position !== undefined) {
		params.position = number(call, position)
	}
	return params
}

function flag(call: string, value: LiteralValue): boolean {
	if (value.kind !== 'boolean') {
		throw expected(call, 'a boolean option', value)
	}
	return value.value
}

function unsupported(call: string, receiver: z.ZodType): Refusal {
	return new Refusal(`${call} is not a method of a ${receiver._zod.def.type} schema in the contract subset`, SUBSET)
}
