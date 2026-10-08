import type { Ref } from '../capability'
import type { defineStores } from './fixtures/stores'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Flat<T> = { [K in keyof T]: T[K] }
type Stores = ReturnType<typeof defineStores>
type RowsOf<F extends (...args: never[]) => Promise<readonly unknown[]>> = Flat<Awaited<ReturnType<F>>[number]>

/** The row types the stores return, pinned: tsc fails when one drifts. */
export type RowTypes = [
	Expect<Equal<RowsOf<Stores['notes']['list']>, { id: string; title: string }>>,
	Expect<Equal<RowsOf<Stores['notes']['latest']>, { id: string; title: string; created_by: string }>>,
	Expect<Equal<RowsOf<Stores['notes']['withComments']>, { id: string; title: string; 'note_comments.id': string; 'note_comments.body': string }>>,
	Expect<Equal<RowsOf<Stores['notes']['countPerWorkspace']>, { workspace_id: string; readonly count: string }>>,
	Expect<
		Equal<
			RowsOf<Stores['notes']['words']>,
			{
				readonly count: string
				readonly sum_word_count: string | number | null
				readonly min_word_count: number | null
				readonly max_created_at: Date | null
			}
		>
	>,
	Expect<Equal<RowsOf<Stores['comments']['ofNote']>, { id: string; body: string }>>,
	Expect<Equal<RowsOf<Stores['comments']['countPerNote']>, { note_id: string; readonly count: string }>>,
	Expect<
		Equal<
			keyof Awaited<ReturnType<Stores['notes']['get']>>,
			'id' | 'workspace_id' | 'organization_id' | 'title' | 'body' | 'word_count' | 'created_by' | 'version' | 'created_at'
		>
	>,
	Expect<Equal<Awaited<ReturnType<Stores['notes']['get']>>['version'], number>>,
	// A mutation answers an acknowledgement, never row data.
	Expect<Equal<Awaited<ReturnType<Stores['notes']['create']>>, { readonly id: string; readonly version: number }>>,
	Expect<Equal<Awaited<ReturnType<Stores['notes']['update']>>, { readonly id: string; readonly version: number }>>,
	Expect<
		Equal<
			Flat<Awaited<ReturnType<Stores['notes']['move']>>>,
			{ readonly id: string; readonly version: number; readonly chain: Readonly<Record<string, string>> }
		>
	>,
	Expect<Equal<Awaited<ReturnType<Stores['workspaces']['rename']>>, { readonly id: string }>>,
	Expect<Equal<Awaited<ReturnType<Stores['comments']['add']>>, { readonly id: string }>>,
	Expect<Equal<Ref<'note', 'notes.read'> extends Ref<'note', 'notes.delete'> ? true : false, false>>,
	Expect<Equal<Ref<'note', 'notes.read'> extends Ref<'workspace', 'notes.read'> ? true : false, false>>,
]
