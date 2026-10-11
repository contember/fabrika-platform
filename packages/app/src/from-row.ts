// `fromRow(Schema, row)`: a database row as an endpoint's output object. The row's snake_case columns become the
// schema's camelCase fields, a `Date` becomes its ISO text, every column the schema does not declare is dropped, and
// the schema parses what is left — so a literal-string field the row types as plain text is checked, not trusted.

import { z } from 'zod/v4'
import { project } from './implement/project'

/** `companyId` → `company_id`: the column a field is read from. */
type Snake<S extends string> = S extends `${infer Head}${infer Tail}` ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${Snake<Tail>}`
	: S

/** A row value a field accepts: text for a literal string (the schema checks it), a `Date` for ISO text. */
type Widened<V> = V extends string ? string | Date : V

/** The row `fromRow` takes for `S`: one column per declared field; any other column is allowed and dropped. */
export type RowInput<S extends z.ZodObject> = { readonly [K in keyof z.input<S> as Snake<K & string>]: Widened<z.input<S>[K]> }

function camel(column: string): string {
	return column.replace(/_([a-z0-9])/g, (_match, next: string) => next.toUpperCase())
}

/** The row as `schema`'s output; a row the schema refuses throws, as a handler's bug. */
export function fromRow<const S extends z.ZodObject>(schema: S, row: RowInput<S>): z.output<S> {
	const fields: Record<string, unknown> = {}
	for (const [column, value] of Object.entries(row)) {
		Object.defineProperty(fields, camel(column), { value: value instanceof Date ? value.toISOString() : value, enumerable: true })
	}
	return z.parse(schema, project(schema, fields))
}
