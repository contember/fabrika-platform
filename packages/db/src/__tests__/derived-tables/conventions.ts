// A written table's `version` and `created_by` columns are its version and creator unless its policy names others:
// the schema, the policies that state neither, and the types the handles read from them, pinned.

import type { Acknowledgement, Tables, VersionArguments } from '../../policy'
import { defineTables } from '../../tables'
import type { TypedColumnList } from '../../vocabulary-tables'
import { vocabulary } from './schema'

export interface StampedDB {
	workspaces: { id: string; name: string }
	notes: { id: string; workspace_id: string; title: string; version: number; created_by: string; revision: number }
	/** Neither column: nothing is stamped. */
	note_comments: { id: string; note_id: string; workspace_id: string; body: string }
	/** Both columns, but read-only: a reference table is never written, so nothing is stamped. */
	countries: { code: string; name: string; version: number; created_by: string }
	/** A `version` that holds no number cannot be the version, so the policy names another column. */
	releases: { id: string; version: string; build: number }
}

export const stampedColumns: TypedColumnList<StampedDB> = {
	workspaces: { columns: ['id', 'name'], foreignKeys: [] },
	notes: {
		columns: ['id', 'workspace_id', 'title', 'version', 'created_by', 'revision'],
		foreignKeys: [{ columns: ['workspace_id'], table: 'workspaces', references: ['id'] }],
	},
	note_comments: {
		columns: ['id', 'note_id', 'workspace_id', 'body'],
		foreignKeys: [{ columns: ['note_id', 'workspace_id'], table: 'notes', references: ['id', 'workspace_id'] }],
	},
	countries: { columns: ['code', 'name', 'version', 'created_by'], foreignKeys: [] },
	releases: { columns: ['id', 'version', 'build'], foreignKeys: [] },
}

export const stated = {
	workspaces: { scope: { dimension: 'workspace' }, actions: { read: 'notes.read' } },
	notes: { scope: { dimension: 'note' }, actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write' }, update: ['title'] },
	note_comments: { scope: { child: 'notes' }, actions: { read: 'notes.read', insert: 'notes.write' }, insert: ['body'] },
	countries: { scope: { reference: 'lookup data' }, actions: { read: 'notes.read' } },
	releases: {
		scope: { app: 'the releases every workspace sees' },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write' },
		insert: ['version'],
		update: ['version'],
		version: 'build',
	},
} as const

export const conventional = defineTables(vocabulary, stampedColumns)(stated)

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type PoliciesOf<T> = T extends Tables<StampedDB, infer P> ? P : never
type Policies = PoliciesOf<typeof conventional>

/** What a mutation answers and takes, by the conventional columns: tsc fails when one drifts. */
export type ConventionTypes = [
	Expect<Equal<Policies['notes']['version'], 'version'>>,
	Expect<Equal<Policies['notes']['createdBy'], 'created_by'>>,
	Expect<Equal<Acknowledgement<Policies, 'notes'>, { readonly id: string; readonly version: number }>>,
	Expect<Equal<VersionArguments<Policies, 'notes'>, [options: { readonly expectVersion: number }]>>,
	Expect<Equal<Acknowledgement<Policies, 'note_comments'>, { readonly id: string }>>,
	Expect<Equal<VersionArguments<Policies, 'note_comments'>, []>>,
	Expect<Equal<'createdBy' extends keyof Policies['note_comments'] ? true : false, false>>,
	Expect<Equal<'version' extends keyof Policies['countries'] ? true : false, false>>,
	Expect<Equal<Policies['releases']['version'], 'build'>>,
]
