// The rule of the application rows an endpoint access case seeds (`appRows`): which tables, columns and values they
// may name, which foreign keys link one given row to another, and the order they are seeded in. `@fabrika/check`
// reports each refusal from source, and `@fabrika/db/testing` throws it before it seeds anything, both in the words of
// `applicationRowRefusalText`. Browser-safe.

import { inSet } from './builtins'
import { type ForeignKey, modelOf, type TableModels } from './policy'

/** Why the values of a set of application rows cannot be seeded as given. */
export type ApplicationRowRefusal =
	/** `table` is no application table: `mode` is its scope mode, or `null` when no policy names it. */
	| { readonly kind: 'table'; readonly table: string; readonly mode: string | null }
	/** `column` is no column of `table`'s column list. */
	| { readonly kind: 'column'; readonly table: string; readonly column: string }
	/** `column` is the row's key, version or creator, which the seeding stamps. */
	| { readonly kind: 'stamped'; readonly table: string; readonly column: string }
	/** `column` is a file column, which the seeding fills with a live, scanned file. */
	| { readonly kind: 'file'; readonly table: string; readonly column: string }
	/** `column` is given an array or an object, where a column takes one value. */
	| { readonly kind: 'value'; readonly table: string; readonly column: string; readonly given: 'array' | 'object' }
	/** The values give `columns`, some but not all columns of the foreign key `key`. */
	| { readonly kind: 'partial-key'; readonly table: string; readonly columns: readonly string[]; readonly key: ForeignKey }
	/** The foreign keys that link `tables` form a cycle, so no order seeds each after the rows it links to. */
	| { readonly kind: 'cycle'; readonly tables: readonly string[] }

export interface ApplicationRowsPlan {
	/** The application tables, each after every given table it links to. */
	readonly order: readonly string[]
	/** Each application table's foreign keys to another given table that the values leave to the link. */
	readonly links: Readonly<Record<string, readonly ForeignKey[]>>
	/** Every refusal, by table then column; a cycle last. Empty when the rows can be seeded. */
	readonly refusals: readonly ApplicationRowRefusal[]
}

/** The plan of seeding one row of each table `rows` names (table → column → value). */
export function planApplicationRows(models: TableModels, rows: Readonly<Record<string, Readonly<Record<string, unknown>>>>): ApplicationRowsPlan {
	const given = Object.keys(rows).sort()
	const refusals: ApplicationRowRefusal[] = []
	const links: Record<string, readonly ForeignKey[]> = {}
	for (const table of given) {
		const model = modelOf(models, table)
		const scope = model?.scope
		if (model === undefined || scope?.mode !== 'app') {
			refusals.push({ kind: 'table', table, mode: scope?.mode ?? null })
			continue
		}
		const values: Readonly<Record<string, unknown>> = (Object.hasOwn(rows, table) ? rows[table] : undefined) ?? {}
		const named = Object.keys(values).sort()
		const stamped = [scope.key, model.version, model.createdBy]
		for (const column of named) {
			const value = values[column]
			if (!inSet(model.columns, column)) {
				refusals.push({ kind: 'column', table, column })
			} else if (stamped.includes(column)) {
				refusals.push({ kind: 'stamped', table, column })
			} else if (Object.hasOwn(model.files, column)) {
				refusals.push({ kind: 'file', table, column })
			} else if (value !== null && typeof value === 'object') {
				refusals.push({ kind: 'value', table, column, given: Array.isArray(value) ? 'array' : 'object' })
			}
		}
		// A foreign key is given whole or not at all: the seeding fills one it is not given (the seeded row of a given
		// table, else null or a referenced row), never the rest of one.
		for (const key of model.foreignKeys) {
			const set = key.columns.filter((column) => named.includes(column))
			if (set.length > 0 && set.length < key.columns.length) refusals.push({ kind: 'partial-key', table, columns: set, key })
		}
		links[table] = model.foreignKeys.filter((key) =>
			key.table !== table && given.includes(key.table) && key.columns.every((column) => !named.includes(column))
		)
	}
	// A table comes after every given table it links to; a cycle among them has no such order.
	const order: string[] = []
	const pending = given.filter((table) => Object.hasOwn(links, table))
	while (pending.length > 0) {
		const next = pending.findIndex((table) => (links[table] ?? []).every((key) => !pending.includes(key.table)))
		if (next === -1) {
			refusals.push({ kind: 'cycle', tables: [...pending] })
			break
		}
		order.push(...pending.splice(next, 1))
	}
	return { order, links, refusals }
}

/** A refusal in the words both the checker and the test kit use, so the two never describe one rule differently. */
export function applicationRowRefusalText(refusal: ApplicationRowRefusal): string {
	switch (refusal.kind) {
		case 'table':
			return `${refusal.table} is ${
				refusal.mode === null ? 'no table of src/db/tables.ts' : `a ${refusal.mode} table`
			}, and an application row is seeded only in an application table (scope: { app })`
		case 'column':
			return `${refusal.table}.${refusal.column} is no column of ${refusal.table}`
		case 'stamped':
			return `${refusal.table}.${refusal.column} is the row's key, version or creator, which the seeding stamps`
		case 'file':
			return `${refusal.table}.${refusal.column} is a file column, which the seeding fills with a live, scanned file`
		case 'value':
			return `${refusal.table}.${refusal.column} is given ${refusal.given === 'array' ? 'an array' : 'an object'}, and a seeded column takes one value`
		case 'partial-key':
			return `${refusal.table}.${refusal.columns.join(', ')} is part of the foreign key to ${refusal.key.table} (${
				refusal.key.columns.join(', ')
			}), which is given whole or not at all`
		case 'cycle':
			return `the foreign keys of ${refusal.tables.join(', ')} form a cycle, so the seeding cannot seed each row after the row it refers to`
	}
}
