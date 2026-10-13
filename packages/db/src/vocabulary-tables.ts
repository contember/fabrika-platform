// The table policies of the vocabulary form, `defineTables(vocabulary, columns)`: how an application writes them, with
// containment taken from the vocabulary, and the normalized policies the kit and the handles read. Types only.

import type { ColumnList, ColumnPolicies, InboxPolicy, ReferencePolicy, TableActions, Tables, VersionColumn } from './policy'

declare const databaseType: unique symbol

/**
 * The generated column list (`src/db/schema.generated.ts`), which also carries the schema's row types, so that
 * `defineTables(vocabulary, columns)` takes no type argument. The brand is type-only: no value has the property.
 */
export type TypedColumnList<DB> = ColumnList<DB> & { readonly [databaseType]?: DB }

/** The row types a typed column list carries; `never` for a list without them. */
export type ColumnTypes<C> = typeof databaseType extends keyof C ? C extends { readonly [databaseType]?: infer DB } ? Exclude<DB, undefined> : never
	: never

/**
 * What `defineTables(vocabulary, columns)` reads of `@fabrika/app/contract`'s `defineVocabulary` result: the action
 * and dimension names, and each dimension's container. `@fabrika/db` does not import `@fabrika/app`.
 */
export interface TableVocabulary {
	readonly actions: { readonly [action: string]: string }
	readonly dimensions: { readonly [dimension: string]: { readonly in?: string } }
}

export type VocabularyAction<V> = V extends { readonly actions: infer A } ? keyof A & string : never
export type VocabularyDimension<V> = V extends { readonly dimensions: infer D } ? keyof D & string : never

/** The dimension `D` lies in, by the vocabulary; `never` for a top-level one. */
export type VocabularyContainerOf<V, D> = V extends { readonly dimensions: infer Ds }
	? D extends keyof Ds ? Ds[D] extends { readonly in: infer C extends string } ? C : never : never
	: never

/** A table without an `id` column names its key. */
interface NamesItsKey<Col extends string> {
	readonly key: Col
}

/** `key` defaults to `id`, so it is required only where the table has no `id` column. */
type KeyField<Col extends string> = 'id' extends Col ? { readonly key?: Col } : NamesItsKey<Col>

/** A contained dimension table's container column; `dimension`, when stated, must be the vocabulary's. */
export interface VocabularyContainer<C extends string, Col extends string> {
	readonly column: Col
	readonly dimension?: C
}

/** A contained table off the `<container>_id` convention names its container column. */
interface NamesItsContainerColumn<C extends string, Col extends string> {
	readonly in: VocabularyContainer<C, Col>
}

/** The container column defaults to `<container>_id`, so `in` is required only off that convention. */
type ContainerField<C extends string, Col extends string> = [C] extends [never] ? { readonly in?: never }
	: `${C}_id` extends Col ? { readonly in?: VocabularyContainer<C, Col> }
	: NamesItsContainerColumn<C, Col>

/** The scope of a table that owns dimension `D`, which the vocabulary puts in `C` (`never`: in no container). */
type DimensionTableScope<D extends string, C extends string, Col extends string> = { readonly dimension: D } & KeyField<Col> & ContainerField<C, Col>

/** A dimension table's scope: the dimension it owns; its container is the vocabulary's. */
export type VocabularyDimensionScope<V, D extends string, Col extends string> = DimensionTableScope<D, VocabularyContainerOf<V, D>, Col>

/** A child table's scope: `column` defaults to `<parent dimension>_id`, and the inherited chain is the parent's. */
export type VocabularyChildScope<Table extends string, Col extends string> =
	& { readonly child: Table; readonly column?: Col; readonly inherit?: readonly Col[] }
	& KeyField<Col>

interface WritableFields<Col extends string, A extends string, Ver extends Col> {
	readonly actions: TableActions<A>
	readonly insert?: readonly Col[]
	readonly update?: readonly Col[]
	readonly version?: Ver
	readonly createdBy?: Col
	readonly columns?: ColumnPolicies<Col, A>
}

/**
 * The scope of the dimension the policy states (`S`, its scope as written); for any other name, the dimension alone,
 * so that a misspelt one is reported against the vocabulary's dimension names rather than against one of them. With
 * no scope as written (an annotated map), every dimension's scope.
 */
type DimensionScopes<V, Col extends string, S> = unknown extends S
	? { [D in VocabularyDimension<V>]: VocabularyDimensionScope<V, D, Col> }[VocabularyDimension<V>]
	: S extends { readonly dimension: infer D extends VocabularyDimension<V> } ? DimensionTableScope<D, VocabularyContainerOf<V, D>, Col>
	: { readonly dimension: VocabularyDimension<V> }

type StatedDimensionOf<P, T> = T extends keyof P ? P[T] extends { readonly scope: { readonly dimension: infer D extends string } } ? D : never
	: never

/** A child off the `<parent dimension>_id` convention names its column for the parent. */
interface NamesItsParentColumn<Col extends string> {
	readonly column: Col
}

/** The column for the parent defaults to `<ParentDimension>_id`, so `column` is required only off that convention. */
type ParentColumnField<ParentDimension extends string, Col extends string> = `${ParentDimension}_id` extends Col ? { readonly column?: Col }
	: NamesItsParentColumn<Col>

/** The scope of a child of `Parent`, a table that owns `ParentDimension`. */
type ChildTableScope<Parent extends string, ParentDimension extends string, Col extends string> =
	& { readonly child: Parent; readonly inherit?: readonly Col[] }
	& KeyField<Col>
	& ParentColumnField<ParentDimension, Col>

/**
 * The scope of the child as written, by the parent it states (`P`, the policies as written): its parent is a table
 * that states a dimension scope, and its column defaults to that table's dimension. With no policies as written, any
 * table.
 */
type ChildScopes<Table extends string, Col extends string, S, P> = unknown extends P ? VocabularyChildScope<Table, Col>
	: S extends { readonly child: infer Parent extends string }
		? [StatedDimensionOf<P, Parent>] extends [never]
			? { readonly child: { [T in keyof P]: P[T] extends { readonly scope: { readonly dimension: string } } ? T : never }[keyof P] & string }
		: ChildTableScope<Parent, StatedDimensionOf<P, Parent>, Col>
	: VocabularyChildScope<Table, Col>

type AuthoredDimensionPolicy<Col extends string, A extends string, V, Ver extends Col, S> = WritableFields<Col, A, Ver> & {
	readonly scope: DimensionScopes<V, Col, S>
}
type AuthoredChildPolicy<Table extends string, Col extends string, A extends string, Ver extends Col, S, P> = WritableFields<Col, A, Ver> & {
	readonly scope: ChildScopes<Table, Col, S, P>
}
/** An application table's scope: why its rows belong to no dimension; `key` defaults to `id`. */
type AuthoredApplicationPolicy<Col extends string, A extends string, Ver extends Col> = WritableFields<Col, A, Ver> & {
	readonly scope: { readonly app: string } & KeyField<Col>
}

/**
 * One table's policy as an application writes it under a vocabulary. `S` is its scope as written: its mode picks the
 * one policy form a mistake is reported against, rather than a union of all five. `P` is every policy as written.
 */
export type VocabularyTablePolicy<Table extends string, Col extends string, A extends string, V, Ver extends Col, S = unknown, P = unknown> =
	S extends { readonly dimension: unknown } ? AuthoredDimensionPolicy<Col, A, V, Ver, S>
		: S extends { readonly child: unknown } ? AuthoredChildPolicy<Table, Col, A, Ver, S, P>
		: S extends { readonly app: unknown } ? AuthoredApplicationPolicy<Col, A, Ver>
		: S extends { readonly reference: unknown } ? ReferencePolicy<Col, A>
		: S extends { readonly inbox: unknown } ? InboxPolicy<Col, A>
		:
			| AuthoredDimensionPolicy<Col, A, V, Ver, S>
			| AuthoredChildPolicy<Table, Col, A, Ver, S, P>
			| AuthoredApplicationPolicy<Col, A, Ver>
			| ReferencePolicy<Col, A>
			| InboxPolicy<Col, A>

type StatedScope<P, T> = T extends keyof P ? P[T] extends { readonly scope: infer S } ? S : unknown : unknown

/** The policy of table `T` with nothing stated: every form, every dimension's scope, any parent. */
type AnyTablePolicy<DB, V, T extends keyof DB & string> = VocabularyTablePolicy<
	keyof DB & string,
	keyof DB[T] & string,
	VocabularyAction<V>,
	V,
	VersionColumn<DB[T]>
>

/**
 * Every table of the schema, and no other, maps to a policy; a misspelt action or dimension fails at its own line.
 * `P` is the policies as written, which picks each table's form by the scope it states; a policy written under this
 * map's own annotation states nothing narrower, so it is checked against every form.
 */
export type VocabularyPolicyMap<DB, V, P = unknown> = {
	readonly [T in keyof DB & string]: AnyTablePolicy<DB, V, T> extends (T extends keyof P ? P[T] : unknown) ? AnyTablePolicy<DB, V, T>
		: VocabularyTablePolicy<keyof DB & string, keyof DB[T] & string, VocabularyAction<V>, V, VersionColumn<DB[T]>, StatedScope<P, T>, P>
}

type Flat<T> = { [K in keyof T]: T[K] }

type KeyOf<S> = S extends { readonly key: infer K extends string } ? K : 'id'

type ContainerColumn<S, C extends string> = S extends { readonly in: { readonly column: infer Col extends string } } ? Col : `${C}_id`

type ParentDimension<P, T> = T extends keyof P ? P[T] extends { readonly scope: { readonly dimension: infer D extends string } } ? D : never
	: never

type NormalScope<S, V, P> = S extends { readonly dimension: infer D extends string } ? Flat<
		& { readonly dimension: D; readonly key: KeyOf<S> }
		& ([VocabularyContainerOf<V, D>] extends [never] ? unknown
			: {
				readonly in: { readonly dimension: VocabularyContainerOf<V, D>; readonly column: ContainerColumn<S, VocabularyContainerOf<V, D>> }
			})
	>
	: S extends { readonly child: infer T extends string } ? {
			readonly child: T
			readonly key: KeyOf<S>
			readonly column: S extends { readonly column: infer C extends string } ? C : `${ParentDimension<P, T>}_id`
			readonly inherit: readonly string[]
		}
	: S extends { readonly app: infer R extends string } ? { readonly app: R; readonly key: KeyOf<S> }
	: S

/**
 * The policies as the layer models them: every dimension table's key and container, and every child's key and
 * column, stated as the vocabulary and the conventions derive them.
 */
export type NormalizedPolicies<P, V> = {
	readonly [T in keyof P]: P[T] extends { readonly scope: infer S } ? Flat<Omit<P[T], 'scope'> & { readonly scope: NormalScope<S, V, P> }> : P[T]
}

/** Takes the policies of exactly the tables of the schema, written in the vocabulary form. */
export type DefineVocabularyPolicies<DB, V> = <const P extends VocabularyPolicyMap<DB, V, P>>(
	policies: P & { readonly [K in Exclude<keyof P, keyof DB>]: never },
) => Tables<DB, NormalizedPolicies<P, V>>
