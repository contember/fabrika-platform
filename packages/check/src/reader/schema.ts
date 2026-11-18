// A `z` chain of the contract subset read as the schema `@fabrika/app/schema` holds as data, one factory or method at a
// time. Each step is replayed against zod at once, through the same replay the runtime builds with, so a refused step
// is reported where it stands, and `@fabrika/app`'s `describeContract` reads exactly the schema the evaluated module
// would hold. The reader keeps the recipe, not the zod: what it builds stays in the bounded cache of the replay.

import { DataEnum, DataObject, DataSchema, SCHEMA_SUBSET, SchemaRefusal, Unreadable, zodSchemaOf } from '@fabrika/app/schema'
import { z } from 'zod/v4'
import type { LiteralValue } from './value'

/** A schema the reader holds: one it read from a chain, or a framework schema (`signedToken()`, `file()`). */
export type ReadSchema = DataSchema | z.ZodType

export type SchemaStep = { readonly factory: string; readonly iso: boolean } | { readonly method: string; readonly receiver: ReadSchema | undefined }

export type BuiltSchema = { readonly ok: true; readonly schema: DataSchema } | {
	readonly ok: false
	readonly message: string
	readonly allowed: string
}

export function buildSchema(step: SchemaStep, args: readonly LiteralValue[]): BuiltSchema {
	try {
		const node = 'factory' in step
			? nodeOf(step.factory, step.iso, null, args.map(argument))
			: nodeOf(step.method, false, receiverOf(step.receiver), args.map(argument))
		// Built now, so a refusal points at its step; the build stays cached for the step that follows.
		zodSchemaOf(node)
		return { ok: true, schema: node }
	} catch (error) {
		if (error instanceof SchemaRefusal) {
			return { ok: false, message: error.message, allowed: error.allowed }
		}
		throw error
	}
}

const OBJECT_METHODS: ReadonlySet<string> = new Set(['extend', 'pick', 'omit', 'partial'])

/** The node of the class `@fabrika/app/schema`'s builder makes for the same call: an object, an enum, or any schema. */
function nodeOf(name: string, iso: boolean, receiver: DataSchema | null, args: readonly unknown[]): DataSchema {
	const object = receiver === null ? name === 'strictObject' : OBJECT_METHODS.has(name) || (name === 'describe' && isObject(receiver))
	if (object) {
		return new DataObject<z.core.$ZodShape, z.core.$ZodObjectConfig>(name, iso, receiver, args)
	}
	if ((receiver === null && name === 'enum') || (name === 'describe' && receiver instanceof DataEnum)) {
		return new DataEnum<z.core.util.EnumLike>(name, iso, receiver, args)
	}
	return new DataSchema(name, iso, receiver, args)
}

function isObject(schema: DataSchema): boolean {
	return schema instanceof DataObject || schema.wrapped instanceof z.ZodObject
}

function receiverOf(receiver: ReadSchema | undefined): DataSchema {
	if (receiver === undefined) {
		throw new SchemaRefusal('a schema method without a schema', SCHEMA_SUBSET)
	}
	return receiver instanceof DataSchema ? receiver : DataSchema.wrap(receiver)
}

/** A read argument as the evaluated call would get it; any other kind stays one the replay refuses by its name. */
function argument(value: LiteralValue): unknown {
	switch (value.kind) {
		case 'string':
		case 'number':
		case 'boolean':
		case 'regex':
			return value.value
		case 'null':
			return null
		case 'array':
			return value.items.map(argument)
		case 'object':
			return Object.fromEntries([...value.entries].map(([key, entry]) => [key, argument(entry)]))
		case 'schema':
			return value.schema
		default:
			return new Unreadable(value.kind)
	}
}
