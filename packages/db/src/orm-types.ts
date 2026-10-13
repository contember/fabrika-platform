// The mini-ORM's handle types: what `ctx.db` holds for each access form, looked up in a `DbIndex` an application's kit
// builds once. Types only, so `@fabrika/db/tables` exports them to the browser-safe contract. A method an endpoint
// may not call is an `Unavailable` tuple: calling it fails at the call, and the message names the fix.

import type { Selectable, Updateable } from 'kysely'
import type { ConditionTuple } from './description'
import type {
	ActionOf,
	ApplicationTableName,
	ChildTableName,
	ContainerOf,
	DimensionOf,
	DimensionTableName,
	InsertValues,
	ListDimensionOf,
	ParentOf,
	Tables,
	UpdateValues,
} from './policy'
import type { AggregateRow, AggregateSpec } from './store'
import type { VocabularyContainerOf } from './vocabulary-tables'

/** A member an endpoint may not use. It has no call signature, so a call fails at its line with this message. */
export type Unavailable<Message extends string> = readonly [unavailable: Message]

/** A query reads; a mutation also writes and locks; a job reads, and writes only inside its fenced transaction. */
export type DataKind = 'query' | 'mutation' | 'job'

/** What an endpoint's access form makes of `ctx.db.target`: one object (`on`), or a scope to read and insert in (`in`). */
export type TargetForm = 'on' | 'in'

type Flat<T> = { [K in keyof T]: T[K] }

type PolicyOf<P, T> = T extends keyof P ? P[T] : never

type ModeOf<P, T> = PolicyOf<P, T> extends { readonly scope: infer S } ? S extends { readonly dimension: string } ? 'dimension'
	: S extends { readonly child: string } ? 'child'
	: S extends { readonly app: string } ? 'app'
	: S extends { readonly reference: string } ? 'reference'
	: 'inbox'
	: never

type ReadActionOf<P, T> = PolicyOf<P, T> extends { readonly scope: { readonly read: infer A extends string } } ? A : ActionOf<P, T, 'read'>

/** Each column that declares its own read action, by column. */
type ColumnReadsOf<P, T> = PolicyOf<P, T> extends { readonly columns: infer C } ? {
		readonly [K in keyof C as C[K] extends { readonly read: string } ? K : never]: C[K] extends { readonly read: infer A extends string } ? A : never
	}
	: Record<never, never>

type ColumnPoliciesOf<P, T> = PolicyOf<P, T> extends { readonly columns: infer C } ? C : never

/** The columns that declare `A` as their own write action. */
type ColumnsWrittenBy<C, A> = { [K in keyof C]: C[K] extends { readonly write: A } ? K : never }[keyof C]

/**
 * Each action that updates the table, with the values a capability of it updates: the update action its update list,
 * a column's own write action the columns that declare it, and no other.
 */
type UpdatesOf<DB, P, T extends keyof DB> =
	& { readonly [A in ActionOf<P, T, 'update'>]: UpdateValues<DB, P, T> }
	& {
		readonly [A in ColumnWriteAction<ColumnPoliciesOf<P, T>>]: Flat<
			Pick<Updateable<DB[T]>, ColumnsWrittenBy<ColumnPoliciesOf<P, T>, A> & keyof Updateable<DB[T]>>
		>
	}

type ColumnWriteAction<C> = { [K in keyof C]: C[K] extends { readonly write: infer A extends string } ? A : never }[keyof C]

/** One table, as every handle reads it. */
export interface IndexedTable {
	readonly mode: 'dimension' | 'child' | 'app' | 'reference' | 'inbox'
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
	/** Each action that updates the table, with the values it updates (`columns: { assignee: { write: 'tasks.assign' } }`). */
	readonly writes: object
	/** The containment columns a row carries: what a scoped write stamps from its capability, and an unscoped one takes. */
	readonly chain: string
	readonly versioned: boolean
}

type IndexedTableOf<DB, P, T extends keyof P & keyof DB & string, V = unknown> = {
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
	readonly row: RowType<DB[T]>
	readonly reads: ColumnReadsOf<P, T>
	readonly insert: InsertValues<DB, P, T>
	readonly update: UpdateValues<DB, P, T>
	readonly writes: UpdatesOf<DB, P, T>
	readonly chain: ChainColumns<P, T, V>
	readonly versioned: PolicyOf<P, T> extends { readonly version: string } ? true : false
}

type OwnerTable<P, D> = { [K in keyof P]: P[K] extends { readonly scope: { readonly dimension: D } } ? K : never }[keyof P]

/** The dimensions above `D` by the vocabulary `V`, nearest first: `never` without a vocabulary or at the top. */
type VocabularyAncestors<V, D> = VocabularyContainerOf<V, D> extends infer C extends string
	? [C] extends [never] ? never : C | VocabularyAncestors<V, C>
	: never

/**
 * A row's containment columns: a dimension table's container and its chain; a child's parent and its. Above a dimension
 * no table owns, the vocabulary's ancestry on the `<dimension>_id` convention, as the layer stamps it.
 */
type ChainColumns<P, T, V> = PolicyOf<P, T> extends { readonly scope: infer S } ? S extends {
		readonly in: { readonly dimension: infer C extends string; readonly column: infer Col extends string }
	} ? Col | ([OwnerTable<P, C>] extends [never] ? `${VocabularyAncestors<V, C>}_id` : ChainColumns<P, OwnerTable<P, C>, V>)
	: S extends { readonly child: infer Parent extends string; readonly column: infer Col extends string } ? Col | ChainColumns<P, Parent, V>
	: never
	: never

/** The dimensions of a row's containment chain: a dimension table's container and above; a child's parent and above. */
type ChainDimensions<P, T, V> = PolicyOf<P, T> extends { readonly scope: infer S }
	? S extends { readonly in: { readonly dimension: infer C extends string } }
		? C | ([OwnerTable<P, C>] extends [never] ? VocabularyAncestors<V, C> : ChainDimensions<P, OwnerTable<P, C>, V>)
	: S extends { readonly child: infer Parent extends string } ? DimensionOf<P, Parent> | ChainDimensions<P, Parent, V>
	: never
	: never

/** The dimensions whose `Within` lists table `T`: every dimension of its chain, and a top-level table's own. */
type ReachOf<P, T, V> = [ContainerOf<P, T>] extends [never] ? DimensionOf<P, T> | ChainDimensions<P, T, V> : ChainDimensions<P, T, V>

/**
 * A row as reads return it: the generated interface itself where no column has a separate write type, so a
 * diagnostic names it (`DealsTable`), and Kysely's `Selectable` of it otherwise.
 */
type RowType<R> = [R] extends [Selectable<R>] ? [Selectable<R>] extends [R] ? R : Selectable<R> : Selectable<R>

type ReferenceTableName<P> = { [K in keyof P]: P[K] extends { readonly scope: { readonly reference: string } } ? K : never }[keyof P] & string

/**
 * Every table of an application, and the lookups the handles need, built once by the kit (`defineApp`) so that each
 * endpoint's context is a property lookup, not a pass over the policies. `V`, the vocabulary, gives a row's chain above
 * a dimension no table owns, as the layer derives it.
 */
export type DbIndex<DB, P, V = unknown> = {
	readonly tables: { readonly [T in keyof P & keyof DB & string]: IndexedTableOf<DB, P, T, V> }
	/** Dimension → the table that owns it. */
	readonly owner: { readonly [T in DimensionTableName<P> as DimensionOf<P, T>]: T }
	/** Parent table → its child tables. */
	readonly children: { readonly [T in ChildTableName<P> as ParentOf<P, T>]: T }
	/** Dimension → the dimension tables listed in it: those it contains, and a top-level table its own. */
	readonly listed: { readonly [T in DimensionTableName<P> as ListDimensionOf<P, T>]: T }
	/** Dimension → the tables an `over` of it lists: each whose containment chain holds it, and a top-level table its own. */
	readonly within: { readonly [T in DimensionTableName<P> | ChildTableName<P> as ReachOf<P, T, V>]: T }
	readonly references: ReferenceTableName<P>
	/** The application tables: an `app` endpoint reads and writes them. */
	readonly applications: ApplicationTableName<P>
	/** The dimension and child tables: an `app` endpoint reads each whose read action is its own. */
	readonly records: DimensionTableName<P> | ChildTableName<P>
}

/** What every handle type takes: a `DbIndex`. */
export interface AnyDbIndex {
	readonly tables: { readonly [table: string]: IndexedTable }
	readonly owner: object
	readonly children: object
	readonly listed: object
	readonly within: object
	readonly references: string
	readonly applications: string
	readonly records: string
}

type TableName<Ix extends AnyDbIndex> = keyof Ix['tables'] & string
type Lookup<M, K> = K extends keyof M ? M[K] & string : never
type OwnerOf<Ix extends AnyDbIndex, D> = Lookup<Ix['owner'], D>
type ChildrenOf<Ix extends AnyDbIndex, T> = Lookup<Ix['children'], T>
type ListedIn<Ix extends AnyDbIndex, D> = Lookup<Ix['listed'], D>
type WithinIn<Ix extends AnyDbIndex, D> = Lookup<Ix['within'], D>

/**
 * The columns a capability of action `A` cannot read: each that declares a read action other than exactly `A`. A
 * union `A` (a widened capability type) holds no single action provably, so it reads none of them.
 */
type HiddenFor<Reads, A> = { [C in keyof Reads]: [A] extends [Reads[C]] ? ([Reads[C]] extends [A] ? never : C) : C }[keyof Reads]

/**
 * A row as a capability of action `A` reads, filters and sorts it: a column that declares another read action is
 * absent. The type keeps the generated row's name, so a read of a hidden column reports
 * `Property 'margin' does not exist on type 'Omit<Selectable<DealsTable>, "margin">'`.
 */
export type RowFor<E extends IndexedTable, A extends string> = [HiddenFor<E['reads'], A>] extends [never] ? E['row']
	: Omit<E['row'], HiddenFor<E['reads'], A>>

/** What a paved-road write answers: the key, and the new version of a versioned table. */
export type Saved<E extends IndexedTable> = E['versioned'] extends true ? { readonly id: string; readonly version: number } : { readonly id: string }

/** A versioned table's update and remove take `{ expectVersion }`; another table's take nothing. */
export type VersionArguments<E extends IndexedTable> = E['versioned'] extends true ? [options: { readonly expectVersion: number }] : []

/** The actions table `E` names: its read, insert, update and delete actions, and each column's own write action. */
type NamedActions<E extends IndexedTable> = (E['actions'][keyof E['actions']] | keyof E['writes']) & string

type Names<E extends IndexedTable, A extends string> = [A] extends [NamedActions<E>] ? true : false

type Operation = 'insert' | 'update' | 'delete'

/** `Member` in a mutation whose action is the table's `Op` action; otherwise the message that says which fix applies. */
type Write<T extends string, E extends IndexedTable, Op extends Operation, A extends string, K extends DataKind, Member> = K extends 'mutation'
	? [A] extends [E['actions'][Op]] ? Member
	: Unavailable<`${Op} on ${T} needs the action '${E['actions'][Op] & string}', and this endpoint holds '${A}'`>
	: K extends 'job' ? Unavailable<'a job writes inside ctx.transaction((tx) => …): use tx.db there'>
	: Unavailable<`${Op extends 'delete' ? 'remove' : Op} writes, so it runs only in a mutation: declare the endpoint with r.mutation`>

/** What an update of `T` needs, for a capability of `A` that updates nothing of it. */
type UpdateRefusal<T extends string, E extends IndexedTable, A extends string> = [Exclude<keyof E['writes'], E['actions']['update']>] extends [never]
	? `update on ${T} needs the action '${E['actions']['update'] & string}', and this endpoint holds '${A}'`
	: [E['actions']['update']] extends [never] ? `update on ${T} needs a column's own write action, and this endpoint holds '${A}'`
	: `update on ${T} needs the action '${E['actions']['update'] & string}' or a column's own write action, and this endpoint holds '${A}'`

/**
 * `Member` in a mutation whose action updates columns of the table (the update action, or a column's own write
 * action); otherwise the message that says which fix applies.
 */
type Update<T extends string, E extends IndexedTable, A extends string, K extends DataKind, Member> = K extends 'mutation'
	? [A] extends [keyof E['writes']] ? Member : Unavailable<UpdateRefusal<T, E, A>>
	: K extends 'job' ? Unavailable<'a job writes inside ctx.transaction((tx) => …): use tx.db there'>
	: Unavailable<'update writes, so it runs only in a mutation: declare the endpoint with r.mutation'>

/** An update's values: any non-empty subset of the columns a capability of `A` updates; an empty one is refused. */
type UpdateValuesOf<E extends IndexedTable, A extends string> = E['writes'][A & keyof E['writes']]

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
		: K extends 'job' ? Unavailable<'a job writes inside ctx.transaction((tx) => …): use tx.db there'>
		: Unavailable<'getForUpdate locks the row, so it runs only in a mutation: declare the endpoint with r.mutation'>
	readonly update: F extends 'on' ? Update<
			T,
			E,
			A,
			K,
			(values: { [C in keyof UpdateValuesOf<E, A>]: UpdateValuesOf<E, A>[C] }, ...version: VersionArguments<E>) => Promise<Saved<E>>
		>
		: Unavailable<'update acts on one object: declare access with on'>
	readonly remove: F extends 'on' ? Write<T, E, 'delete', A, K, (...version: VersionArguments<E>) => Promise<void>>
		: Unavailable<'remove acts on one object: declare access with on'>
}

/**
 * The row of a top-level scope, under `in` or `creates`: IAM holds the scope, the application inserts its row, keyed
 * by the scope's value.
 */
export interface OwnerRow<T extends string, E extends IndexedTable, A extends string, K extends DataKind> {
	readonly insert: Write<T, E, 'insert', A, K, (values: { [C in keyof E['insert']]: E['insert'][C] }) => Promise<Saved<E>>>
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
	readonly insert: Write<T, E, 'insert', A, K, (values: { [C in keyof E['insert']]: E['insert'][C] }) => Promise<Saved<E>>>
	readonly update: Update<
		T,
		E,
		A,
		K,
		(key: string, values: { [C in keyof UpdateValuesOf<E, A>]: UpdateValuesOf<E, A>[C] }, ...version: VersionArguments<E>) => Promise<Saved<E>>
	>
	readonly remove: Write<T, E, 'delete', A, K, (key: string, ...version: VersionArguments<E>) => Promise<void>>
}

/** A dimension table the target contains: listed in it, and inserted into it by a mutation of its insert action. */
export interface ContainedRows<T extends string, E extends IndexedTable, A extends string, K extends DataKind> {
	readonly list: Read<T, E, A, (options?: ListOptions<RowFor<E, A>>) => Promise<ListPage<RowFor<E, A>>>>
	readonly insert: Write<T, E, 'insert', A, K, (values: { [C in keyof E['insert']]: E['insert'][C] }) => Promise<Saved<E>>>
}

type SubtreeTables<Ix extends AnyDbIndex, D extends string, A extends string, K extends DataKind, F extends TargetForm> =
	& { readonly [C in ChildrenOf<Ix, OwnerOf<Ix, D>>]: ChildRows<C, Ix['tables'][C], A, K> }
	& { readonly [C in Exclude<ListedIn<Ix, D>, OwnerOf<Ix, D>>]: ContainedRows<C, Ix['tables'][C], A, K> }
	& { readonly [C in F extends 'in' ? OwnerOf<Ix, D> & ListedIn<Ix, D> : never]: OwnerRow<C, Ix['tables'][C], A, K> }

/**
 * `ctx.db.target`: the target's row and its subtree — its child tables and the dimension tables it contains; under
 * `in` (and `creates`) also the insert of a top-level scope's own row.
 */
export type ScopeTarget<Ix extends AnyDbIndex, D extends string, A extends string, K extends DataKind, F extends TargetForm> =
	& ([OwnerOf<Ix, D>] extends [never] ? UnownedTarget<D> : TargetRow<OwnerOf<Ix, D>, Ix['tables'][OwnerOf<Ix, D>], A, K, F>)
	& SubtreeTables<Ix, D, A, K, F>

/** A table listed in an `over` endpoint's dimension, read through its `Within`. */
export interface WithinRows<T extends string, E extends IndexedTable, A extends string> {
	readonly list: A extends E['actions']['read'] ? (options?: ListOptions<RowFor<E, A>>) => Promise<ListPage<RowFor<E, A>>>
		: Unavailable<ListRefusal<T, E, A>>
	readonly count: A extends E['actions']['read'] ? (options?: CountOptions<RowFor<E, A>>) => Promise<number> : Unavailable<ListRefusal<T, E, A>>
	readonly aggregate: A extends E['actions']['read']
		? <const S extends AggregateSpec<RowFor<E, A>>>(spec: S) => Promise<AggregateRow<RowFor<E, A>, S>[]>
		: Unavailable<ListRefusal<T, E, A>>
}

/** Inlined where used: an alias of its own would be printed by name, with the table's index entry spelled out. */
type ListRefusal<T extends string, E extends IndexedTable, A extends string> = `a list of ${T} needs its read action '${
	& E['actions']['read']
	& string}', and this endpoint holds '${A}'`

/**
 * `ctx.db.within` of an `over` endpoint: every table whose containment chain holds its dimension (tasks two levels
 * down through their stamped `org_id`), and a top-level table its own; child tables included.
 */
export type WithinTables<Ix extends AnyDbIndex, D extends string, A extends string> = {
	readonly [T in WithinIn<Ix, D>]: WithinRows<T, Ix['tables'][T], A>
}

/** An application table under the capability of an `app` endpoint of action `A`, in a site of kind `K`. */
export interface ApplicationRows<T extends string, E extends IndexedTable, A extends string, K extends DataKind> {
	readonly list: A extends E['actions']['read'] ? (options?: ListOptions<RowFor<E, A>>) => Promise<ListPage<RowFor<E, A>>>
		: Unavailable<ListRefusal<T, E, A>>
	readonly count: A extends E['actions']['read'] ? (options?: CountOptions<RowFor<E, A>>) => Promise<number> : Unavailable<ListRefusal<T, E, A>>
	readonly aggregate: A extends E['actions']['read']
		? <const S extends AggregateSpec<RowFor<E, A>>>(spec: S) => Promise<AggregateRow<RowFor<E, A>, S>[]>
		: Unavailable<ListRefusal<T, E, A>>
	/** One row by its key; a column that declares another read action than `A` is hidden. */
	readonly get: Read<T, E, A, (key: string) => Promise<RowFor<E, A>>>
	/** `SELECT … FOR UPDATE` of one row by its key: a precondition read that no concurrent write overtakes. */
	readonly getForUpdate: K extends 'mutation' ? Read<T, E, A, (key: string) => Promise<RowFor<E, A>>>
		: K extends 'job' ? Unavailable<'a job writes inside ctx.transaction((tx) => …): use tx.db there'>
		: Unavailable<'getForUpdate locks the row, so it runs only in a mutation: declare the endpoint with r.mutation'>
	readonly insert: Write<T, E, 'insert', A, K, (values: { [C in keyof E['insert']]: E['insert'][C] }) => Promise<Saved<E>>>
	readonly update: Update<
		T,
		E,
		A,
		K,
		(key: string, values: { [C in keyof UpdateValuesOf<E, A>]: UpdateValuesOf<E, A>[C] }, ...version: VersionArguments<E>) => Promise<Saved<E>>
	>
	readonly remove: Write<T, E, 'delete', A, K, (key: string, ...version: VersionArguments<E>) => Promise<void>>
}

/**
 * `ctx.db.app` of an `app` endpoint: every application table, and every dimension and child table read-only, all
 * rows, where the endpoint's action is its read action (`over` with `'all'` reads them so).
 */
export type ApplicationTables<Ix extends AnyDbIndex, A extends string, K extends DataKind> =
	& { readonly [T in Ix['applications']]: ApplicationRows<T, Ix['tables'][T], A, K> }
	& { readonly [T in Ix['records']]: WithinRows<T, Ix['tables'][T], A> }

/** The row a site reads without a capability of its own: through the table's read action. */
type TableRow<E extends IndexedTable> = RowFor<E, E['actions']['read']>

/** A reference table: every endpoint reads it, through its read action, and none writes it. */
export interface ReferenceRows<E extends IndexedTable> {
	list(options?: ListOptions<TableRow<E>>): Promise<ListPage<TableRow<E>>>
	count(options?: CountOptions<TableRow<E>>): Promise<number>
}

/** `ctx.db.reference`. */
export type ReferenceTables<Ix extends AnyDbIndex> = { readonly [T in Ix['references']]: ReferenceRows<Ix['tables'][T]> }

/** The mode an endpoint, job or webhook declares for a table outside its scope. */
export type UnscopedMode = 'read' | 'write'

/** `unscoped: { <table>: 'read' | 'write' }` as a site may declare it: only tables of `src/db/tables.ts`. */
export type UnscopedDeclaration<Table extends string, Mode extends UnscopedMode> = { readonly [T in Table]?: Mode }

/** A table a site declared `unscoped`: its scope predicate is `true`, and `'read'` writes nothing. */
export interface UnscopedRows<T extends string, E extends IndexedTable, M extends UnscopedMode, K extends DataKind> {
	list(options?: ListOptions<TableRow<E>>): Promise<ListPage<TableRow<E>>>
	count(options?: CountOptions<TableRow<E>>): Promise<number>
	aggregate<const S extends AggregateSpec<TableRow<E>>>(spec: S): Promise<AggregateRow<TableRow<E>, S>[]>
	get(key: string): Promise<TableRow<E>>
	readonly insert: UnscopedWrite<T, M, K, 'insert', (values: { [C in keyof UnscopedInsert<E>]: UnscopedInsert<E>[C] }) => Promise<Saved<E>>>
	readonly update: UnscopedWrite<
		T,
		M,
		K,
		'update',
		(key: string, values: { [C in keyof E['update']]: E['update'][C] }, ...version: VersionArguments<E>) => Promise<Saved<E>>
	>
	readonly remove: UnscopedWrite<T, M, K, 'remove', (key: string, ...version: VersionArguments<E>) => Promise<void>>
}

/**
 * An unscoped insert has no capability to stamp the containment from, so it takes the containment columns; the key,
 * the version and the creator stay the layer's.
 */
export type UnscopedInsert<E extends IndexedTable> = Flat<E['insert'] & { [C in E['chain'] & keyof E['row']]: E['row'][C] }>

/** `Member` for a table declared `'write'`, in a site that writes there; otherwise the declaration or place to fix. */
type UnscopedWrite<T extends string, M extends UnscopedMode, K extends DataKind, Op extends string, Member> = M extends 'write'
	? K extends 'job' ? Unavailable<'a job writes inside ctx.transaction((tx) => …): use tx.db there'> : Member
	: Unavailable<`${T} is declared unscoped: 'read', so ${Op} needs unscoped: { ${T}: 'write' }`>

/** `ctx.db.unscoped`: the declared tables in their mode; any other table names the declaration to add. */
export type UnscopedTables<Ix extends AnyDbIndex, U, K extends DataKind> = {
	readonly [T in TableName<Ix>]: U extends { readonly [Q in T]: infer M extends UnscopedMode } ? UnscopedRows<T, Ix['tables'][T], M, K>
		: Unavailable<`${T} is outside this site's scope: declare unscoped: { ${T}: 'read' } on it`>
}

/** `ctx.db.unscoped` of a site that declares none. */
export type NoUnscoped = Unavailable<"this site declares no unscoped table: add unscoped: { <table>: 'read' } to its declaration">

type TableEntry<Tb, T> = Tb extends Tables<infer DB, infer P> ? T extends keyof P & keyof DB & string ? IndexedTableOf<DB, P, T> : never : never

/** The tables of a `defineTables` result. */
export type TableNameOf<Tb> = Tb extends Tables<infer DB, infer P> ? keyof P & keyof DB & string : never

/**
 * The row of table `T` as a capability of `A` reads it — what `ctx.db.*.get()` and a list's items are:
 * `RowOf<typeof tables, 'tasks', 'tasks.read'>`. `A` is an action the table names and defaults to its read action;
 * every column that declares another read action is absent.
 */
export type RowOf<
	Tb,
	T extends TableNameOf<Tb>,
	A extends (TableEntry<Tb, T>['actions'][keyof TableEntry<Tb, T>['actions']] | keyof TableEntry<Tb, T>['writes']) & string = TableEntry<
		Tb,
		T
	>['actions']['read'],
> = RowFor<TableEntry<Tb, T>, A>
