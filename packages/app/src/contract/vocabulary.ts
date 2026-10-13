// `defineVocabulary`: the authorization vocabulary of an application, the first module of its staged kit. It knows
// nothing else, so the tables, the kit, the groups and the contract can each be typed by it without a cycle.
// Browser-safe: plain data.

import { type DimensionDef, type Presentation, presentationOf, type RoleDefs, type Vocabulary, type WildcardMessage } from './define'

/** The vocabulary as `defineVocabulary` returned it, with its literal names and dimension definitions. */
export interface AppVocabulary<A extends string, D extends string, R extends string, Dims> extends Vocabulary<A, D, R> {
	readonly dimensions: Dims & { readonly [K in D]: DimensionDef<A, D, R> }
}

export type AnyAppVocabulary = AppVocabulary<string, string, string, unknown>

/**
 * Declares the dimensions, actions and roles, and how IAM names the application (`locale`, `displayName`). `src/vocabulary.ts` exports it; `defineTables`, `defineApp` and the
 * contract take it, so each name is written once.
 */
export function defineVocabulary<
	const A extends string,
	const D extends string,
	const R extends string,
	const Dims extends { readonly [K in D]: DimensionDef<NoInfer<A>, NoInfer<D>, NoInfer<R>> },
>(
	vocabulary: Presentation & {
		readonly app: string
		readonly dimensions: Dims & { readonly [K in D]: DimensionDef<NoInfer<A>, NoInfer<D>, NoInfer<R>> }
		readonly actions: { readonly [K in A]: K extends `${string}*${string}` ? WildcardMessage : string }
		readonly roles: RoleDefs<NoInfer<A>, NoInfer<D>, R>
	},
): AppVocabulary<A, D, R, Dims> {
	return {
		app: vocabulary.app,
		dimensions: vocabulary.dimensions,
		actions: vocabulary.actions,
		roles: vocabulary.roles,
		...presentationOf(vocabulary),
	}
}
