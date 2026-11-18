// `@fabrika/app/schema`: contract schemas held as data. Import `z` from here instead of `zod/v4` in contract modules;
// the subset, the method names and the inferred types are zod's, and zod is built from a schema only when it is used.

export * as z from './builder'
export {
	type AnySchema,
	BUILT_SCHEMAS,
	DataEnum,
	DataObject,
	DataSchema,
	type DataShapeInput,
	isDataSchema,
	type Message,
	type ZodOf,
	zodOf,
	zodSchemaOf,
} from './data-schema'
export { type ReplayArg, type ReplayStep, replayStep, SCHEMA_SUBSET, SchemaRefusal, Unreadable } from './replay'
