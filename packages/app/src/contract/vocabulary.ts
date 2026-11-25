// `defineVocabulary`: the authorization vocabulary of an application, the first module of its staged kit. It knows
// nothing else, so the tables, the kit, the groups and the contract can each be typed by it without a cycle.
// Browser-safe: plain data.

import {
	type AppMembers,
	type DimensionDef,
	type Presentation,
	presentationOf,
	type RelationDef,
	type RoleDefs,
	type TerminalDeclaration,
	type Vocabulary,
	type WildcardMessage,
} from './define'

/**
 * The vocabulary as `defineVocabulary` returned it, with its literal names, dimension definitions, the actions of its
 * people (`M`, `never` when it declares none), its terminal (`T`, `never` when it declares none) and whether it
 * notifies (`N`, `never` when it does not).
 */
export interface AppVocabulary<
	A extends string,
	D extends string,
	R extends string,
	Dims,
	M extends AppMembers<A> = never,
	T extends TerminalDeclaration = never,
	N extends true = never,
> extends Vocabulary<A, D, R> {
	readonly dimensions: Dims & { readonly [K in D]: DimensionDef<A, D, R> }
	readonly members?: M
	readonly terminal?: T
	readonly notifications?: N
}

export type AnyAppVocabulary = AppVocabulary<string, string, string, unknown, AppMembers<string>, TerminalDeclaration, true>

/**
 * Declares the dimensions, actions and roles, and how IAM names the application (`locale`, `displayName`). `src/vocabulary.ts` exports it; `defineTables`, `defineApp` and the
 * contract take it, so each name is written once.
 */
export function defineVocabulary<
	const A extends string,
	const D extends string,
	const R extends string,
	const Dims extends { readonly [K in D]: DimensionDef<NoInfer<A>, NoInfer<D>, NoInfer<R>> },
	const M extends AppMembers<NoInfer<A>> = never,
	const T extends TerminalDeclaration = never,
	const N extends true = never,
>(
	vocabulary: Presentation & {
		readonly app: string
		readonly dimensions: Dims & { readonly [K in D]: DimensionDef<NoInfer<A>, NoInfer<D>, NoInfer<R>> }
		readonly actions: { readonly [K in A]: K extends `${string}*${string}` ? WildcardMessage : string }
		readonly roles: RoleDefs<NoInfer<A>, NoInfer<D>, R>
		readonly relations?: { readonly [name: string]: RelationDef<NoInfer<D>> }
		readonly members?: M
		readonly directory?: 'labels'
		readonly terminal?: T
		readonly notifications?: N
	},
): AppVocabulary<A, D, R, Dims, M, T, N> {
	const people = vocabulary.members
	return {
		app: vocabulary.app,
		dimensions: vocabulary.dimensions,
		actions: vocabulary.actions,
		roles: vocabulary.roles,
		...(vocabulary.relations === undefined ? {} : { relations: vocabulary.relations }),
		...presentationOf(vocabulary),
		...(people === undefined ? {} : { members: people }),
		...(vocabulary.directory === undefined ? {} : { directory: vocabulary.directory }),
		...(vocabulary.terminal === undefined ? {} : { terminal: vocabulary.terminal }),
		...(vocabulary.notifications === undefined ? {} : { notifications: vocabulary.notifications }),
	}
}
