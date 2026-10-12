// The vocabulary form of the table policies, pinned: containment, keys and child chains left to the vocabulary and the
// `<container>_id` convention, and the normalized policies the kit's index reads. The runtime derivation is
// `@fabrika/db`'s `derived-tables.test.ts`; this module pins the types.

import { type App, defineApp, type KitTypes } from '@fabrika/app/contract'
import { defineTables, type ScopeTarget, type Tables, type WithinTables } from '@fabrika/db/tables'
import { columns, type DB } from './src/db/schema.generated'
import { vocabulary } from './src/vocabulary'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const derived = defineTables(vocabulary, columns)({
	orgs: { scope: { dimension: 'org' }, actions: { read: 'crm.read' } },
	companies: { scope: { dimension: 'company' }, actions: { read: 'crm.read', insert: 'crm.write' }, insert: ['name'] },
	deals: { scope: { dimension: 'deal', in: { column: 'company_id' } }, actions: { read: 'crm.read' } },
	deal_activities: { scope: { child: 'deals' }, actions: { read: 'crm.read', insert: 'deals.write' }, insert: ['body'] },
	countries: { scope: { reference: 'ISO 3166 country names' }, actions: { read: 'crm.read' } },
})

type Policies = typeof derived extends Tables<DB, infer P> ? P : never
type K = ReturnType<typeof defineApp<typeof vocabulary, DB, Policies>> extends App<infer Kit extends KitTypes> ? Kit : never

/** What the layer models: each key, container and child column stated as the vocabulary and the conventions give them. */
export type Normalized = [
	Expect<Equal<Policies['orgs']['scope'], { readonly dimension: 'org'; readonly key: 'id' }>>,
	Expect<
		Equal<
			Policies['companies']['scope'],
			{ readonly dimension: 'company'; readonly key: 'id'; readonly in: { readonly dimension: 'org'; readonly column: 'org_id' } }
		>
	>,
	Expect<Equal<Policies['deals']['scope']['in'], { readonly dimension: 'company'; readonly column: 'company_id' }>>,
	Expect<Equal<Policies['deal_activities']['scope']['column'], 'deal_id'>>,
	Expect<Equal<keyof WithinTables<K['index'], 'org', 'crm.read'>, 'orgs' | 'companies' | 'deals' | 'deal_activities'>>,
	Expect<Equal<K['index']['tables']['deal_activities']['chain'], 'deal_id' | 'company_id' | 'org_id'>>,
	Expect<Equal<'companies' extends keyof ScopeTarget<K['index'], 'org', 'crm.write', 'mutation', 'in'> ? true : false, true>>,
]
