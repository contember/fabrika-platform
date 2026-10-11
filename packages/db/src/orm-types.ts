// The mini-ORM's handle types: what `ctx.db` holds for each access form, looked up in a `DbIndex` an application's kit
// builds once. Types only, so `@fabrika/db/tables` exports them to the browser-safe contract. A method an endpoint
// may not call is an `Unavailable` tuple: calling it fails at the call, and the message names the fix.

import type { Selectable } from 'kysely'
import type { ConditionTuple } from './description'
import type { ActionOf, ChildTableName, DimensionOf, DimensionTableName, InsertValues, ListDimensionOf, ParentOf, UpdateValues } from './policy'
import type { AggregateRow, AggregateSpec } from './store'

/** A member an endpoint may not use. It has no call signature, so a call fails at its line with this message. */
export type Unavailable<Message extends string> = readonly [unavailable: Message]

/** A query reads; a mutation also writes and locks. */
export type DataKind = 'query' | 'mutation'

/** What an endpoint's access form makes of `ctx.db.target`: one object (`on`), or a scope to read and insert in (`in`). */
export type TargetForm = 'on' | 'in'

type Flat<T> = { [K in keyof T]: T[K] }

type PolicyOf<P, T> = T extends keyof P ? P[T] : never

type ModeOf<P, T> = PolicyOf<P, T> extends { readonly scope: infer S } ? S extends { readonly dimension: string } ? 'dimension'
	: S extends { readonly child: string } ? 'child'
	: S extends { readonly reference: string } ? 'reference'
	: 'inbox'
	: never

type ReadActionOf<P, T> = PolicyOf<P, T> extends { readonly scope: { readonly read: infer A extends string } } ? A : ActionOf<P, T, 'read'>

/** Each column that declares its own read action, by column. */
type ColumnReadsOf<P, T> = PolicyOf<P, T> extends { readonly columns: infer C } ? {
		readonly [K in keyof C]: C[K] extends { readonly read: infer A extends string } ? A : never
	}
	: Record<never, never>

/** One table, as every handle reads it. */
export interface IndexedTable {
	readonly mode: 'dimension' | 'child' | 'reference' | 'inbox'
	/** The dimension a dimension table owns. */
	readonly dimension: string
	/** The dimension its rows are listed and inserted in: the container's, or a top-level table's own. */
	readonly list: string
	/** A child table's parent table. */
	readonly parent: string
	readonly actions: { readonly read: string; readonly insert: string; readonly update: string; readonly delete: string }
	/** Every column, before any is hidden. */
	readonly row: object
	/** The columns that declare their own read action. */
	readonly reads: object
	readonly insert: object
	readonly update: object
	readonly versioned: boolean
}

type IndexedTableOf<DB, P, T extends keyof P & keyof DB & string> = {
	readonly mode: ModeOf<P, T>
	readonly dimension: DimensionOf<P, T>
	readonly list: ListDimensionOf<P, T>
	readonly parent: ParentOf<P, T>
	readonly actions: {
		readonly read: ReadActionOf<P, T>
		readonly insert: ActionOf<P, T, 'insert'>
		readonly update: ActionOf<P, T, 'update'>
		readonly delete: ActionOf<P, T, 'delete'>
	}
	readonly row: Flat<Selectable<DB[T]>>
	readonly reads: ColumnReadsOf<P, T>
	readonly insert: InsertValues<DB, P, T>
	readonly update: UpdateValues<DB, P, T>
	readonly versioned: PolicyOf<P, T> extends { readonly version: string } ? true : false
}

type ReferenceTableName<P> = { [K in keyof P]: P[K] extends { readonly scope: { readonly reference: string } } ? K : never }[keyof P] & string

/**
 * Every table of an application, and the lookups the handles need, built once by the kit (`defineApp`) so that each
 * endpoint's context is a property lookup, not a pass over the policies.
 */
export type DbIndex<DB, P> = {
	readonly tables: { readonly [T in keyof P & keyof DB & string]: IndexedTableOf<DB, P, T> }
	/** Dimension → the table that owns it. */
	readonly owner: { readonly [T in DimensionTableName<P> as DimensionOf<P, T>]: T }
	/** Parent table → its child tables. */
	readonly children: { readonly [T in ChildTableName<P> as ParentOf<P, T>]: T }
	/** Dimension → the dimension tables listed in it: those it contains, and a top-level table its own. */
	readonly listed: { readonly [T in DimensionTableName<P> as ListDimensionOf<P, T>]: T }
	readonly references: ReferenceTableName<P>
}

/** What every handle type takes: a `DbIndex`. */
export interface AnyDbIndex {
	readonly tables: { readonly [table: string]: IndexedTable }
	readonly owner: object
	readonly children: object
	readonly listed: object
	readonly references: string
}

type TableName<Ix extends AnyDbIndex> = keyof Ix['tables'] & string
type Lookup<M, K> = K extends keyof M ? M[K] & string : never
type OwnerOf<Ix extends AnyDbIndex, D> = Lookup<Ix['owner'], D>
type ChildrenOf<Ix extends AnyDbIndex, T> = Lookup<Ix['children'], T>
type ListedIn<Ix extends AnyDbIndex, D> = Lookup<Ix['listed'], D>

type HiddenFor<Reads, A> = { [C in keyof Reads]: Reads[C] extends A ? never : C }[keyof Reads]

/** A row as a capability of action `A` reads it: every column that declares another read action is hidden. */
export type RowFor<E extends IndexedTable, A extends string> = Flat<Omit<E['row'], HiddenFor<E['reads'], A>>>

/** What a paved-road write answers: the key, and the new version of a versioned table. */
export type Saved<E extends IndexedTable> = E['versioned'] extends true ? { readonly id: string; readonly version: number } : { readonly id: string }

/** A versioned table's update and remove take `{ expectVersion }`; another table's take nothing. */
export type VersionArguments<E extends IndexedTable> = E['versioned'] extends true ? [options: { readonly expectVersion: number }] : []

type Names<E extends IndexedTable, A extends string> = A extends E['actions'][keyof E['actions']] ? true : false

type Operation = 'insert' | 'update' | 'delete'

/** `Member` in a mutation whose action is the table's `Op` action; otherwise the message that says which fix applies. */
type Write<T extends string, E extends IndexedTable, Op extends Operation, A extends string, K extends DataKind, Member> = K extends 'mutation'
	? A extends E['actions'][Op] ? Member : Unavailable<`${Op} on ${T} needs the action '${E['actions'][Op] & string}', and this endpoint holds '${A}'`>
	: Unavailable<`${Op extends 'delete' ? 'remove' : Op} writes, so it runs only in a mutation: declare the endpoint with r.mutation`>

type Read<T extends string, E extends IndexedTable, A extends string, Member> = Names<E, A> extends true ? Member
	: Unavailable<`${T} does not name the action '${A}': read it from an endpoint whose action ${T} names, or declare unscoped`>

/** One page of a keyset list; `next` is the cursor `after` takes, `null` on the last page. */
export interface ListPage<Row> {
	readonly items: Row[]
	readonly next: string | null
}

export type OrderTerm<Row> = { [C in keyof Row & string]: readonly [C, 'asc' | 'desc'] }[keyof Row & string]

export interface ListOptions<Row> {
	readonly where?: readonly ConditionTuple<Row>[]
	readonly orderBy?: readonly OrderTerm<Row>[]
	readonly limit?: number
	readonly after?: string
}

export interface CountOptions<Row> {
	readonly where?: readonly ConditionTuple<Row>[]
}

/** The target's own row: `ctx.db.target` (or `ctx.db.created`) of an `on`, `in` or `creates` endpoint. */
export interface TargetRow<T extends string, E extends IndexedTable, A extends string, K extends DataKind, F extends TargetForm> {
	/** The row; a column that declares another read action than `A` is hidden. */
	readonly get: Read<T, E, A, () => Promise<RowFor<E, A>>>
	/** `SELECT … FOR UPDATE` on the target: a precondition read that no concurrent write overtakes. */
	readonly getForUpdate: K extends 'mutation'
		? F extends 'on' ? Read<T, E, A, () => Promise<RowFor<E, A>>> : Unavailable<'getForUpdate locks one object: declare access with on'>
		: Unavailable<'getForUpdate locks the row, so it runs only in a mutation: declare the endpoint with r.mutation'>
	readonly update: F extends 'on' ? Write<T, E, 'update', A, K, (values: E['update'], ...version: VersionArguments<E>) => Promise<Saved<E>>>
		: Unavailable<'update acts on one object: declare access with on'>
	readonly remove: F extends 'on' ? Write<T, E, 'delete', A, K, (...version: VersionArguments<E>) => Promise<void>>
		: Unavailable<'remove acts on one object: declare access with on'>
}

/** A dimension no table owns has no row of its own; its subtree tables are still reachable. */
export interface UnownedTarget<D extends string> {
	readonly get: Unavailable<`no table owns the dimension ${D}, so ctx.db.target has no row of its own`>
	readonly getForUpdate: Unavailable<`no table owns the dimension ${D}, so ctx.db.target has no row of its own`>
	readonly update: Unavailable<`no table owns the dimension ${D}, so ctx.db.target has no row of its own`>
	readonly remove: Unavailable<`no table owns the dimension ${D}, so ctx.db.target has no row of its own`>
}

/** A child table of the target: its rows are addressed by their own key under the target. */
export interface ChildRows<T extends string, E extends IndexedTable, A extends string, K extends DataKind> {
	readonly list: Read<T, E, A, (options?: ListOptions<RowFor<E, A>>) => Promise<ListPage<RowFor<E, A>>>>
	readonly get: Read<T, E, A, (key: string) => Promise<RowFor<E, A>>>
	readonly insert: Write<T, E, 'insert', A, K, (values: E['insert']) => Promise<Saved<E>>>
	readonly update: Write<T, E, 'update', A, K, (key: string, values: E['update'], ...version: VersionArguments<E>) => Promise<Saved<E>>>
	readonly remove: Write<T, E, 'delete', A, K, (key: string, ...version: VersionArguments<E>) => Promise<void>>
}

/** A dimension table the target contains: listed in it, and inserted into it by a mutation of its insert action. */
export interface ContainedRows<T extends string, E extends IndexedTable, A extends string, K extends DataKind> {
	readonly list: Read<T, E, A, (options?: ListOptions<RowFor<E, A>>) => Promise<ListPage<RowFor<E, A>>>>
	readonly insert: Write<T, E, 'insert', A, K, (values: E['insert']) => Promise<Saved<E>>>
}

type SubtreeTables<Ix extends AnyDbIndex, D extends string, A extends string, K extends DataKind> =
	& { readonly [C in ChildrenOf<Ix, OwnerOf<Ix, D>>]: ChildRows<C, Ix['tables'][C], A, K> }
	& { readonly [C in Exclude<ListedIn<Ix, D>, OwnerOf<Ix, D>>]: ContainedRows<C, Ix['tables'][C], A, K> }

/** `ctx.db.target`: the target's row and its subtree — its child tables and the dimension tables it contains. */
export type ScopeTarget<Ix extends AnyDbIndex, D extends string, A extends string, K extends DataKind, F extends TargetForm> =
	& ([OwnerOf<Ix, D>] extends [never] ? UnownedTarget<D> : TargetRow<OwnerOf<Ix, D>, Ix['tables'][OwnerOf<Ix, D>], A, K, F>)
	& SubtreeTables<Ix, D, A, K>

/** A table listed in an `over` endpoint's dimension, read through its `Within`. */
export interface WithinRows<T extends string, E extends IndexedTable, A extends string> {
	readonly list: A extends E['actions']['read'] ? (options?: ListOptions<RowFor<E, A>>) => Promise<ListPage<RowFor<E, A>>> : WithinRead<T, E, A>
	readonly count: A extends E['actions']['read'] ? (options?: CountOptions<RowFor<E, A>>) => Promise<number> : WithinRead<T, E, A>
	readonly aggregate: A extends E['actions']['read']
		? <const S extends AggregateSpec<RowFor<E, A>>>(spec: S) => Promise<AggregateRow<RowFor<E, A>, S>[]>
		: WithinRead<T, E, A>
}

type WithinRead<T extends string, E extends IndexedTable, A extends string> = Unavailable<
	`a list of ${T} needs its read action '${E['actions']['read'] & string}', and this endpoint holds '${A}'`
>

/** `ctx.db.within` of an `over` endpoint: every table listed in its dimension. */
export type WithinTables<Ix extends AnyDbIndex, D extends string, A extends string> = {
	readonly [T in ListedIn<Ix, D>]: WithinRows<T, Ix['tables'][T], A>
}

/** A reference table: every endpoint reads it, none writes it. */
export interface ReferenceRows<E extends IndexedTable> {
	list(options?: ListOptions<E['row']>): Promise<ListPage<E['row']>>
	count(options?: CountOptions<E['row']>): Promise<number>
}

/** `ctx.db.reference`. */
export type ReferenceTables<Ix extends AnyDbIndex> = { readonly [T in Ix['references']]: ReferenceRows<Ix['tables'][T]> }

/** The mode an endpoint, job or webhook declares for a table outside its scope. */
export type UnscopedMode = 'read' | 'write'

/** `unscoped: { <table>: 'read' | 'write' }` as a site may declare it: only tables of `src/db/tables.ts`. */
export type UnscopedDeclaration<Table extends string, Mode extends UnscopedMode> = { readonly [T in Table]?: Mode }

/** A table a site declared `unscoped`: its scope predicate is `true`, and `'read'` writes nothing. */
export interface UnscopedRows<T extends string, E extends IndexedTable, M extends UnscopedMode> {
	list(options?: ListOptions<E['row']>): Promise<ListPage<E['row']>>
	count(options?: CountOptions<E['row']>): Promise<number>
	aggregate<const S extends AggregateSpec<E['row']>>(spec: S): Promise<AggregateRow<E['row'], S>[]>
	get(key: string): Promise<E['row']>
	readonly insert: M extends 'write' ? (values: E['insert']) => Promise<Saved<E>> : UnscopedReadOnly<T, 'insert'>
	readonly update: M extends 'write' ? (key: string, values: E['update'], ...version: VersionArguments<E>) => Promise<Saved<E>>
		: UnscopedReadOnly<T, 'update'>
	readonly remove: M extends 'write' ? (key: string, ...version: VersionArguments<E>) => Promise<void> : UnscopedReadOnly<T, 'remove'>
}

type UnscopedReadOnly<T extends string, Op extends string> = Unavailable<
	`${T} is declared unscoped: 'read', so ${Op} needs unscoped: { ${T}: 'write' }`
>

/** `ctx.db.unscoped`: the declared tables in their mode; any other table names the declaration to add. */
export type UnscopedTables<Ix extends AnyDbIndex, U> = {
	readonly [T in TableName<Ix>]: U extends { readonly [Q in T]: infer M extends UnscopedMode } ? UnscopedRows<T, Ix['tables'][T], M>
		: Unavailable<`${T} is outside this site's scope: declare unscoped: { ${T}: 'read' } on it`>
}

/** `ctx.db.unscoped` of a site that declares none. */
export type NoUnscoped = Unavailable<"this site declares no unscoped table: add unscoped: { <table>: 'read' } to its declaration">
