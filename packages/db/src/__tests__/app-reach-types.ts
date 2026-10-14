// The `app` reach of a dimension table, pinned: tsc fails when one drifts. An `appRead` action reads the columns of
// its own action, as a `Ref` does (`RowFor`); an `appCount` action counts and has no aggregate, whose groups are values.

import type { AppRecordRows, DbIndex, Tables, Unavailable } from '../tables'
import type { DB } from './fixtures/schema'
import type { tables } from './fixtures/tables'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type Policies = typeof tables extends Tables<DB, infer P> ? P : never
type Index = DbIndex<DB, Policies>
type AppNotes<A extends string> = AppRecordRows<'notes', Index['tables']['notes'], A>
type Listed<A extends string> = AppNotes<A>['list'] extends (...args: never[]) => Promise<{ readonly items: readonly (infer R)[] }> ? R : never

export type AppReachTypes = [
	// `title` declares `notes.read` and `internal` declares `notes.delete`: the export's rows hold neither.
	Expect<Equal<'title' extends keyof Listed<'notes.export'> ? true : false, false>>,
	Expect<Equal<'internal' extends keyof Listed<'notes.export'> ? true : false, false>>,
	Expect<Equal<'body' extends keyof Listed<'notes.export'> ? true : false, true>>,
	Expect<Equal<'title' extends keyof Listed<'notes.read'> ? true : false, true>>,
	Expect<
		Equal<
			AppNotes<'notes.count'>['aggregate'],
			Unavailable<
				"an aggregate of notes needs its read action 'notes.read' or an action of its appRead, and this endpoint holds 'notes.count': an appCount action only counts"
			>
		>
	>,
]
