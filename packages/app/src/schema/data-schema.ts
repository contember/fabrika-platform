// A schema held as data: the `z` call that made it, its receiver and its arguments, and no zod object. Zod is built
// from it only when something validates, by replaying the same calls (`replay.ts`), and a bounded cache keeps the most
// recently used builds, so an application's schemas cost their recipe, not the whole zod graph, while it runs.

import { z } from 'zod/v4'
import { type ReplayArg, replayStep, SCHEMA_SUBSET, SchemaRefusal, Unreadable } from './replay'

/** A schema a contract may hold: one held as data, or a zod schema (a framework schema such as `signedToken()`). */
export type AnySchema = DataSchema<z.ZodType> | z.ZodType

/** The zod type a schema denotes: its own type for a zod schema. */
export type ZodOf<S> = S extends DataSchema<infer T extends z.core.$ZodType> ? T : S extends z.core.$ZodType ? S : never

/** The fields an object is declared with. */
export type DataShapeInput = { readonly [key: string]: AnySchema }

/** The zod shape of `S`, as `z.strictObject` would hold it. */
export type ZodShape<S extends DataShapeInput> = { [K in keyof S]: ZodOf<S[K]> }

/** The zod types of a list of schemas, as `z.union` or `z.tuple` would hold them. */
export type ZodList<O extends readonly AnySchema[]> = { [I in keyof O]: ZodOf<O[I]> }

/** An error message, or the options object that carries one. */
export type Message = string | { readonly message?: string; readonly error?: string }

/** What `min`, `max` and `length` bound: a string's length, an array's items, a number. */
type Sized = (z.ZodString | z.ZodStringFormat | z.ZodArray) & z.core.$ZodType
type Bounded = (Sized | z.ZodNumber) & z.core.$ZodType
type Text = (z.ZodString | z.ZodStringFormat) & z.core.$ZodType

/** The name `~zod` marks a node that wraps a zod schema given where a schema stands. */
const WRAPPED = '~zod'

export class DataSchema<T extends z.core.$ZodType = z.core.$ZodType> {
	/** The zod type this schema denotes; declared only, never set. */
	declare readonly '~type'?: T
	/** The factory (`z.<name>`, `z.iso.<name>` when `iso`) or the method that made this schema. */
	readonly name: string
	readonly iso: boolean
	/** The schema a method was called on; `null` for a factory. */
	readonly receiver: DataSchema | null
	readonly args: readonly unknown[]

	constructor(name: string, iso: boolean, receiver: DataSchema | null, args: readonly unknown[]) {
		this.name = name
		this.iso = iso
		this.receiver = receiver
		// A trailing omitted argument is absent, as in the call written without it.
		let length = args.length
		while (length > 0 && args[length - 1] === undefined) {
			length--
		}
		this.args = Object.freeze(args.slice(0, length))
		Object.freeze(this)
	}

	/** A zod schema given where a schema stands, held as one. */
	static wrap<S extends z.core.$ZodType>(schema: S): DataSchema<S> {
		return new DataSchema<S>(WRAPPED, false, null, [schema])
	}

	/** Whether this node only wraps a zod schema. */
	get wrapped(): z.ZodType | null {
		const [schema] = this.args
		return this.name === WRAPPED && schema instanceof z.ZodType ? schema : null
	}

	protected derive<U extends z.core.$ZodType>(name: string, args: readonly unknown[]): DataSchema<U> {
		return new DataSchema<U>(name, false, this, args)
	}

	min<S extends Bounded>(this: DataSchema<S>, value: number, params?: Message): DataSchema<S> {
		return this.derive<S>('min', [value, params])
	}

	max<S extends Bounded>(this: DataSchema<S>, value: number, params?: Message): DataSchema<S> {
		return this.derive<S>('max', [value, params])
	}

	length<S extends Sized>(this: DataSchema<S>, value: number, params?: Message): DataSchema<S> {
		return this.derive<S>('length', [value, params])
	}

	nonempty<S extends Sized>(this: DataSchema<S>, params?: Message): DataSchema<S> {
		return this.derive<S>('nonempty', [params])
	}

	email(this: DataSchema<z.ZodString>, params?: Message): DataSchema<z.ZodString> {
		return this.derive<z.ZodString>('email', [params])
	}

	url(this: DataSchema<z.ZodString>, params?: Message): DataSchema<z.ZodString> {
		return this.derive<z.ZodString>('url', [params])
	}

	uuid(this: DataSchema<z.ZodString>, params?: UuidOptions): DataSchema<z.ZodString> {
		return this.derive<z.ZodString>('uuid', [params])
	}

	startsWith<S extends Text>(this: DataSchema<S>, prefix: string, params?: Message): DataSchema<S> {
		return this.derive<S>('startsWith', [prefix, params])
	}

	endsWith<S extends Text>(this: DataSchema<S>, suffix: string, params?: Message): DataSchema<S> {
		return this.derive<S>('endsWith', [suffix, params])
	}

	includes<S extends Text>(this: DataSchema<S>, part: string, params?: IncludesOptions): DataSchema<S> {
		return this.derive<S>('includes', [part, params])
	}

	regex<S extends Text>(this: DataSchema<S>, pattern: RegExp, params?: Message): DataSchema<S> {
		return this.derive<S>('regex', [pattern, params])
	}

	int<S extends z.ZodNumber>(this: DataSchema<S>, params?: Message): DataSchema<S> {
		return this.derive<S>('int', [params])
	}

	positive<S extends z.ZodNumber>(this: DataSchema<S>, params?: Message): DataSchema<S> {
		return this.derive<S>('positive', [params])
	}

	negative<S extends z.ZodNumber>(this: DataSchema<S>, params?: Message): DataSchema<S> {
		return this.derive<S>('negative', [params])
	}

	nonnegative<S extends z.ZodNumber>(this: DataSchema<S>, params?: Message): DataSchema<S> {
		return this.derive<S>('nonnegative', [params])
	}

	nonpositive<S extends z.ZodNumber>(this: DataSchema<S>, params?: Message): DataSchema<S> {
		return this.derive<S>('nonpositive', [params])
	}

	gt<S extends z.ZodNumber>(this: DataSchema<S>, value: number, params?: Message): DataSchema<S> {
		return this.derive<S>('gt', [value, params])
	}

	gte<S extends z.ZodNumber>(this: DataSchema<S>, value: number, params?: Message): DataSchema<S> {
		return this.derive<S>('gte', [value, params])
	}

	lt<S extends z.ZodNumber>(this: DataSchema<S>, value: number, params?: Message): DataSchema<S> {
		return this.derive<S>('lt', [value, params])
	}

	lte<S extends z.ZodNumber>(this: DataSchema<S>, value: number, params?: Message): DataSchema<S> {
		return this.derive<S>('lte', [value, params])
	}

	multipleOf<S extends z.ZodNumber>(this: DataSchema<S>, value: number, params?: Message): DataSchema<S> {
		return this.derive<S>('multipleOf', [value, params])
	}

	optional(): DataSchema<z.ZodOptional<T>> {
		return this.derive<z.ZodOptional<T>>('optional', [])
	}

	nullable(): DataSchema<z.ZodNullable<T>> {
		return this.derive<z.ZodNullable<T>>('nullable', [])
	}

	nullish(): DataSchema<z.ZodOptional<z.ZodNullable<T>>> {
		return this.derive<z.ZodOptional<z.ZodNullable<T>>>('nullish', [])
	}

	array(): DataSchema<z.ZodArray<T>> {
		return this.derive<z.ZodArray<T>>('array', [])
	}

	default(value: z.core.util.NoUndefined<z.output<T>>): DataSchema<z.ZodDefault<T>> {
		return this.derive<z.ZodDefault<T>>('default', [value])
	}

	describe(description: string): DataSchema<T> {
		return this.derive<T>('describe', [description])
	}

	or<U extends AnySchema>(option: U): DataSchema<z.ZodUnion<[T, ZodOf<U>]>> {
		return this.derive<z.ZodUnion<[T, ZodOf<U>]>>('or', [option])
	}

	/** What zod's `parse` returns for `value`, from the schema this one denotes. */
	parse(value: unknown): z.output<T> {
		return z.parse(this.#zod(), value)
	}

	safeParse(value: unknown): z.ZodSafeParseResult<z.output<T>> {
		return z.safeParse(this.#zod(), value)
	}

	get '~standard'(): T['~standard'] {
		return this.#zod()['~standard']
	}

	#zod(): T {
		return zodOf<DataSchema<T>>(this)
	}
}

/** An object schema: what `z.strictObject` and the methods that derive objects make. */
export class DataObject<Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig> extends DataSchema<z.ZodObject<Shape, Config>> {
	/** The zod fields, as zod's `.shape` holds them. */
	get shape(): Shape {
		return zodOf<DataSchema<z.ZodObject<Shape, Config>>>(this).shape
	}

	extend<U extends DataShapeInput>(shape: U): DataObject<z.core.util.Extend<Shape, ZodShape<U>>, Config> {
		return new DataObject<z.core.util.Extend<Shape, ZodShape<U>>, Config>('extend', false, this, [shape])
	}

	pick<M extends z.core.util.Mask<keyof Shape>>(mask: M): DataObject<z.core.util.Flatten<Pick<Shape, Extract<keyof Shape, keyof M>>>, Config> {
		return new DataObject<z.core.util.Flatten<Pick<Shape, Extract<keyof Shape, keyof M>>>, Config>('pick', false, this, [mask])
	}

	omit<M extends z.core.util.Mask<keyof Shape>>(mask: M): DataObject<z.core.util.Flatten<Omit<Shape, Extract<keyof Shape, keyof M>>>, Config> {
		return new DataObject<z.core.util.Flatten<Omit<Shape, Extract<keyof Shape, keyof M>>>, Config>('omit', false, this, [mask])
	}

	partial<M extends z.core.util.Mask<keyof Shape> = { [K in keyof Shape]: true }>(mask?: M): DataObject<Partialized<Shape, M>, Config> {
		return new DataObject<Partialized<Shape, M>, Config>('partial', false, this, [mask])
	}

	override describe(description: string): DataObject<Shape, Config> {
		return new DataObject<Shape, Config>('describe', false, this, [description])
	}
}

/** `Shape` with the fields `M` names optional, as zod's `.partial(mask)` makes it. */
type Partialized<Shape extends z.core.$ZodShape, M> = { [K in keyof Shape]: K extends keyof M ? z.ZodOptional<Shape[K]> : Shape[K] }

/** An enum schema: what `z.enum` and the methods that narrow an enum make. */
export class DataEnum<E extends z.core.util.EnumLike> extends DataSchema<z.ZodEnum<E>> {
	get options(): z.ZodEnum<E>['options'] {
		return zodOf<DataSchema<z.ZodEnum<E>>>(this).options
	}

	get enum(): E {
		return zodOf<DataSchema<z.ZodEnum<E>>>(this).enum
	}

	exclude<const U extends readonly (keyof E)[]>(keys: U, params?: Message): DataEnum<z.core.util.Flatten<Omit<E, U[number]>>> {
		return new DataEnum<z.core.util.Flatten<Omit<E, U[number]>>>('exclude', false, this, [keys, params])
	}

	extract<const U extends readonly (keyof E)[]>(keys: U, params?: Message): DataEnum<z.core.util.Flatten<Pick<E, U[number]>>> {
		return new DataEnum<z.core.util.Flatten<Pick<E, U[number]>>>('extract', false, this, [keys, params])
	}

	override describe(description: string): DataEnum<E> {
		return new DataEnum<E>('describe', false, this, [description])
	}
}

export type UuidOptions = string | {
	readonly message?: string
	readonly error?: string
	readonly version?: 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'v6' | 'v7' | 'v8'
}

export type IncludesOptions = { readonly message?: string; readonly error?: string; readonly position?: number }

export function isDataSchema(value: unknown): value is DataSchema {
	return value instanceof DataSchema
}

// ── Building zod ────────────────────────────────────────────────────────────────────────────────

/**
 * How many built schemas stay cached: each holds the zod of one schema something validated with, and an endpoint uses
 * two. Sized so a runtime that serves every endpoint of a large contract stays far below a Worker's 128 MB.
 */
export const BUILT_SCHEMAS = 64

const built = new Map<DataSchema, z.ZodType>()

/**
 * The zod schema `schema` denotes: a zod schema itself, or one held as data built. A cached build is reused and becomes
 * the most recent; a schema built anew is cached, and the least recently used beyond `BUILT_SCHEMAS` is dropped. A step
 * outside the subset throws a `SchemaRefusal`.
 */
export function zodSchemaOf(schema: z.core.$ZodType | DataSchema): z.core.$ZodType {
	return schema instanceof DataSchema ? buildCached(schema) : schema
}

/** `zodSchemaOf` with the zod type the schema denotes. */
export function zodOf<S extends z.core.$ZodType | DataSchema>(schema: S): ZodOf<S> {
	// The replay calls exactly the zod functions whose types define the builder's type, so the build is a `ZodOf<S>`.
	return zodSchemaOf(schema) as ZodOf<S>
}

function buildCached(node: DataSchema): z.ZodType {
	const cached = built.get(node)
	if (cached !== undefined) {
		built.delete(node)
		built.set(node, cached)
		return cached
	}
	const schema = build(node)
	built.set(node, schema)
	if (built.size > BUILT_SCHEMAS) {
		const [oldest] = built.keys()
		if (oldest !== undefined) {
			built.delete(oldest)
		}
	}
	return schema
}

/** A schema built without caching it; a part already cached is reused. */
function build(node: DataSchema): z.ZodType {
	const wrapped = node.wrapped
	if (wrapped !== null) {
		return wrapped
	}
	const args = node.args.map((arg) => replayArg(arg, node))
	if (node.receiver === null) {
		return replayStep({ factory: node.name, iso: node.iso }, args)
	}
	return replayStep({ method: node.name, receiver: built.get(node.receiver) ?? build(node.receiver) }, args)
}

/** An argument as zod takes it: a schema in it built, an omitted option left out. */
function replayArg(value: unknown, node: DataSchema): ReplayArg {
	if (value instanceof DataSchema) {
		return built.get(value) ?? build(value)
	}
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof RegExp) {
		return value
	}
	if (value instanceof z.ZodType || value instanceof Unreadable) {
		return value
	}
	if (Array.isArray(value)) {
		return value.map((item: unknown) => replayArg(item, node))
	}
	if (typeof value === 'object') {
		const prototype: unknown = Object.getPrototypeOf(value)
		if (prototype === Object.prototype || prototype === null) {
			const entries: [string, ReplayArg][] = []
			for (const [key, entry] of Object.entries(value)) {
				if (entry !== undefined) {
					entries.push([key, replayArg(entry, node)])
				}
			}
			return Object.fromEntries(entries)
		}
	}
	throw new SchemaRefusal(`a ${typeof value} argument of ${node.receiver === null ? `z.${node.name}()` : `.${node.name}()`}`, SCHEMA_SUBSET)
}
