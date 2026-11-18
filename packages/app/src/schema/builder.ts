// The `z` of `@fabrika/app/schema`: the contract subset of zod's API, each factory recording its call as a
// `DataSchema`. A schema's type is the zod type the same call would return, so `z.infer` reads as zod's own.

import type { z as zod } from 'zod/v4'
import {
	type AnySchema,
	DataEnum,
	DataObject,
	DataSchema,
	type DataShapeInput,
	type Message,
	type UuidOptions,
	type ZodList,
	type ZodOf,
	type ZodShape,
} from './data-schema'

type Primitive = string | number | boolean | null

export type DatetimeOptions = string | {
	readonly message?: string
	readonly error?: string
	readonly offset?: boolean
	readonly local?: boolean
	readonly precision?: number | null
}

export type TimeOptions = string | { readonly message?: string; readonly error?: string; readonly precision?: number | null }

/** What a schema admits once parsed, as `zod`'s `z.output`. */
export type output<S> = zod.output<ZodOf<S>>
/** What a schema takes before parsing, as `zod`'s `z.input`. */
export type input<S> = zod.input<ZodOf<S>>
export type { output as infer }

function factory<T extends zod.ZodType>(name: string, args: readonly unknown[]): DataSchema<T> {
	return new DataSchema<T>(name, false, null, args)
}

export function string(params?: Message): DataSchema<zod.ZodString> {
	return factory('string', [params])
}

export function number(params?: Message): DataSchema<zod.ZodNumber> {
	return factory('number', [params])
}

export function int(params?: Message): DataSchema<zod.ZodInt> {
	return factory('int', [params])
}

export function boolean(params?: Message): DataSchema<zod.ZodBoolean> {
	return factory('boolean', [params])
}

function _null(params?: Message): DataSchema<zod.ZodNull> {
	return factory('null', [params])
}

export function uuid(params?: UuidOptions): DataSchema<zod.ZodUUID> {
	return factory('uuid', [params])
}

export function email(params?: Message): DataSchema<zod.ZodEmail> {
	return factory('email', [params])
}

export function url(params?: Message): DataSchema<zod.ZodURL> {
	return factory('url', [params])
}

export function literal<const L extends Primitive | readonly Primitive[]>(
	value: L,
	params?: Message,
): DataSchema<zod.ZodLiteral<L extends readonly Primitive[] ? L[number] : L>> {
	return factory('literal', [value, params])
}

function _enum<const E extends readonly string[] | zod.core.util.EnumLike>(
	values: E,
	params?: Message,
): DataEnum<E extends readonly string[] ? zod.core.util.ToEnum<E[number]> : E> {
	return new DataEnum<E extends readonly string[] ? zod.core.util.ToEnum<E[number]> : E>('enum', false, null, [values, params])
}

export function strictObject<S extends DataShapeInput>(shape: S, params?: Message): DataObject<ZodShape<S>, zod.core.$strict> {
	return new DataObject<ZodShape<S>, zod.core.$strict>('strictObject', false, null, [shape, params])
}

export function array<E extends AnySchema>(element: E, params?: Message): DataSchema<zod.ZodArray<ZodOf<E>>> {
	return factory('array', [element, params])
}

export function tuple<const I extends readonly AnySchema[], R extends AnySchema = never>(
	items: I,
	rest?: R | Message,
	params?: Message,
): DataSchema<zod.ZodTuple<Extract<ZodList<I>, zod.core.util.TupleItems>, [R] extends [never] ? null : ZodOf<R>>> {
	return factory('tuple', [items, rest, params])
}

export function union<const O extends readonly AnySchema[]>(
	options: O,
	params?: Message,
): DataSchema<zod.ZodUnion<Extract<ZodList<O>, readonly zod.core.SomeType[]>>> {
	return factory('union', [options, params])
}

export function discriminatedUnion<const O extends readonly [AnySchema, ...AnySchema[]]>(
	discriminator: string,
	options: O,
	params?: Message,
): DataSchema<
	zod.ZodDiscriminatedUnion<Extract<ZodList<O>, readonly [zod.core.$ZodTypeDiscriminable, ...zod.core.$ZodTypeDiscriminable[]]>>
> {
	return factory('discriminatedUnion', [discriminator, options, params])
}

export function record<K extends AnySchema, V extends AnySchema>(
	key: K,
	value: V,
	params?: Message,
): DataSchema<zod.ZodRecord<Extract<ZodOf<K>, zod.core.$ZodRecordKey>, ZodOf<V>>> {
	return factory('record', [key, value, params])
}

export function optional<S extends AnySchema>(inner: S): DataSchema<zod.ZodOptional<ZodOf<S>>> {
	return factory('optional', [inner])
}

export function nullable<S extends AnySchema>(inner: S): DataSchema<zod.ZodNullable<ZodOf<S>>> {
	return factory('nullable', [inner])
}

function isoFactory<T extends zod.ZodType>(name: string, params: unknown): DataSchema<T> {
	return new DataSchema<T>(name, true, null, [params])
}

export const iso = Object.freeze({
	date: (params?: Message): DataSchema<zod.ZodISODate> => isoFactory('date', params),
	datetime: (params?: DatetimeOptions): DataSchema<zod.ZodISODateTime> => isoFactory('datetime', params),
	time: (params?: TimeOptions): DataSchema<zod.ZodISOTime> => isoFactory('time', params),
	duration: (params?: Message): DataSchema<zod.ZodISODuration> => isoFactory('duration', params),
})

export { _enum as enum, _null as null }
