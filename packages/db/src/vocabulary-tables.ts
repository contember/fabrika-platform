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

/** `key` defaults to `id`, so it is required only where the table has no `id` column. */
type KeyField<Col extends string> = 'id' extends Col ? { readonly key?: Col } : { readonly key: Col }

/** A contained dimension table's container column; `dimension`, when stated, must be the vocabulary's. */
export interface VocabularyContainer<C extends string, Col extends string> {
	readonly column: Col
	readonly dimension?: C
}

/** The container column defaults to `<container>_id`, so `in` is required only off that convention. */
type ContainerField<C extends string, Col extends string> = [C] extends [never] ? { readonly in?: never }
	: `${C}_id` extends Col ? { readonly in?: VocabularyContainer<C, Col> }
	: { readonly in: VocabularyContainer<C, Col> }

/** A dimension table's scope: the dimension it owns; its container is the vocabulary's. */
export type VocabularyDimensionScope<V, D extends string, Col extends string> =
	& { readonly dimension: D }
	& KeyField<Col>
	& ContainerField<VocabularyContainerOf<V, D>, Col>

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

type DimensionScopes<V, Col extends string> = { [D in VocabularyDimension<V>]: VocabularyDimensionScope<V, D, Col> }[VocabularyDimension<V>]

/** One table's policy as an application writes it under a vocabulary. */
export type VocabularyTablePolicy<Table extends string, Col extends string, A extends string, V, Ver extends Col> =
	| (WritableFields<Col, A, Ver> & { readonly scope: DimensionScopes<V, Col> })
	| (WritableFields<Col, A, Ver> & { readonly scope: VocabularyChildScope<Table, Col> })
	| ReferencePolicy<Col, A>
	| InboxPolicy<Col, A>

/** Every table of the schema, and no other, maps to a policy; a misspelt action or dimension fails at its own line. */
export type VocabularyPolicyMap<DB, V> = {
	readonly [T in keyof DB & string]: VocabularyTablePolicy<keyof DB & string, keyof DB[T] & string, VocabularyAction<V>, V, VersionColumn<DB[T]>>
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
	: S

/**
 * The policies as the layer models them: every dimension table's key and container, and every child's key and
 * column, stated as the vocabulary and the conventions derive them.
 */
export type NormalizedPolicies<P, V> = {
	readonly [T in keyof P]: P[T] extends { readonly scope: infer S } ? Flat<Omit<P[T], 'scope'> & { readonly scope: NormalScope<S, V, P> }> : P[T]
}

/** Takes the policies of exactly the tables of the schema, written in the vocabulary form. */
export type DefineVocabularyPolicies<DB, V> = <const P extends VocabularyPolicyMap<DB, V>>(
	policies: P & { readonly [K in Exclude<keyof P, keyof DB>]: never },
) => Tables<DB, NormalizedPolicies<P, V>>
