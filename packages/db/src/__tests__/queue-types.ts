// A queue table, an idempotent insert and a table two actions read, pinned as types: tsc fails when one drifts.

import type { ColumnType, Generated } from 'kysely'
import type { RowRef } from '../capability'
import { defineTables } from '../policy'
import type { ApplicationTables, ClaimedRow, ClaimedRowHandle, DbIndex, RowOf, Tables, TypedColumnList, Unavailable, WithinTables } from '../tables'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

interface DealsTable {
	id: string
	org_id: string
	name: string
}

interface ReportRequestsTable {
	id: string
	deal_id: string
	org_id: string
	kind: string
	result: string | null
	attempts: Generated<number>
	next_attempt_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
	version: number
}

interface OutboxTable {
	id: string
	recipient: string
	attempts: Generated<number>
	next_attempt_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>
	version: number
}

interface ProductsTable {
	id: string
	name: string
	cost: number | null
}

interface DB {
	deals: DealsTable
	report_requests: ReportRequestsTable
	outbox: OutboxTable
	products: ProductsTable
}

const columns: TypedColumnList<DB> = {
	deals: { columns: ['id', 'org_id', 'name'], foreignKeys: [] },
	report_requests: {
		columns: ['id', 'deal_id', 'org_id', 'kind', 'result', 'attempts', 'next_attempt_at', 'version'],
		foreignKeys: [{ columns: ['deal_id', 'org_id'], table: 'deals', references: ['id', 'org_id'] }],
		timestamps: ['next_attempt_at'],
	},
	outbox: { columns: ['id', 'recipient', 'attempts', 'next_attempt_at', 'version'], foreignKeys: [], timestamps: ['next_attempt_at'] },
	products: { columns: ['id', 'name', 'cost'], foreignKeys: [] },
}

const vocabulary = {
	dimensions: { org: {}, deal: { in: 'org' } },
	actions: {
		'crm.read': 'Read',
		'deals.write': 'Write deals',
		'reports.request': 'Request a report',
		'reports.render': 'Render reports',
		'mail.queue': 'Queue mail',
		'mail.send': 'Send mail',
		'catalog.read': 'Read the catalog',
	},
} as const

export const tables = defineTables(vocabulary, columns)({
	deals: { scope: { dimension: 'deal' }, actions: { read: 'crm.read', insert: 'deals.write' }, insert: ['name'] },
	report_requests: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'reports.request', update: 'reports.render' },
		insert: ['kind'],
		update: ['result'],
		queue: { attempts: 'attempts', due: 'next_attempt_at' },
		version: 'version',
	},
	outbox: {
		scope: { app: 'mail of every organization goes out through one job' },
		actions: { read: 'mail.send', insert: 'mail.queue', update: 'mail.send', delete: 'mail.send' },
		insert: ['recipient', 'next_attempt_at'],
		queue: { attempts: 'attempts', due: 'next_attempt_at', maxAttempts: 3 },
		version: 'version',
	},
	products: {
		scope: { app: 'one catalog per application' },
		actions: { read: ['crm.read', 'catalog.read'] },
		columns: { cost: { read: 'crm.read' } },
	},
})

type Policies = typeof tables extends Tables<DB, infer P> ? P : never
type Index = DbIndex<DB, Policies, typeof vocabulary>
type Outbox<A extends string, K extends 'query' | 'mutation' | 'job'> = ApplicationTables<Index, A, K>['outbox']
type Reports<A extends string, K extends 'query' | 'mutation' | 'job'> = WithinTables<Index, 'deal', A, K>['report_requests']
type Claimed<A extends string> = Outbox<A, 'job'>['claim'] extends (options: infer _) => Promise<(infer R)[]> ? R : never
type Inserted<O> = Outbox<'mail.queue', 'mutation'>['insert'] extends {
	(values: infer _V, options: { readonly onConflict: { readonly columns: infer _C; readonly do: 'nothing' } }): infer N
	(values: infer _W, options: { readonly onConflict: { readonly columns: infer _D; readonly do: 'update' } }): infer U
	(values: infer _X): infer P
} ? (O extends 'nothing' ? N : O extends 'update' ? U : P)
	: never

export type QueueTypes = [
	// A job claims a queue table through a capability of its update action; each row carries its version and ref.
	Expect<Equal<Claimed<'mail.send'>, ClaimedRow<'outbox', Index['tables']['outbox'], 'mail.send'>>>,
	Expect<Equal<Claimed<'mail.send'>['ref'], RowRef<'outbox', 'mail.send'>>>,
	Expect<Equal<Claimed<'mail.send'>['version'], number>>,
	Expect<Equal<Claimed<'mail.send'>['recipient'], string>>,
	Expect<
		Equal<
			Outbox<'mail.queue', 'job'>['claim'],
			Unavailable<"a claim of outbox needs its update action 'mail.send', and this capability holds 'mail.queue'">
		>
	>,
	Expect<
		Equal<
			Outbox<'mail.send', 'mutation'>['claim'],
			Unavailable<'claim leases rows in a transaction of its own: a job calls it on ctx.db before ctx.transaction, never inside one or in a request'>
		>
	>,
	Expect<Equal<Outbox<'mail.send', 'query'>['claim'], Unavailable<'claim leases rows, so it runs only in a job'>>>,
	Expect<Equal<Reports<'reports.render', 'job'>['claim'] extends (options: { readonly limit: number }) => unknown ? true : false, true>>,
	Expect<
		Equal<
			ApplicationTables<Index, 'catalog.read', 'job'>['products']['claim'],
			Unavailable<'products is not a queue table: declare queue: { attempts, due } in its policy'>
		>
	>,
	// The claimed row is finished in the job's transaction: update with done, remove with the delete action, requeue.
	Expect<
		Equal<
			Parameters<ClaimedRowHandle<'outbox', Index['tables']['outbox'], 'mail.send', 'mutation'>['update']>[1],
			{ readonly expectVersion: number; readonly done?: boolean }
		>
	>,
	Expect<
		Equal<
			ClaimedRowHandle<'report_requests', Index['tables']['report_requests'], 'reports.render', 'mutation'>['remove'],
			Unavailable<'report_requests allows no remove: its policy declares no delete action'>
		>
	>,
	Expect<
		Equal<
			ClaimedRowHandle<'outbox', Index['tables']['outbox'], 'mail.send', 'job'>['requeue'],
			Unavailable<'a job writes inside ctx.transaction((tx) => …): use tx.db there'>
		>
	>,
	// An insert answers whether it inserted when it names a conflict.
	Expect<Equal<Inserted<'plain'>, Promise<{ readonly id: string; readonly version: number }>>>,
	Expect<
		Equal<
			Inserted<'nothing'>,
			Promise<({ readonly id: string; readonly version: number } & { readonly inserted: true }) | { readonly inserted: false }>
		>
	>,
	Expect<Equal<Inserted<'update'>, Promise<{ readonly id: string; readonly version: number } & { readonly inserted: boolean }>>>,
	// A table two actions read: either action lists it, and a column of one is hidden from the other.
	Expect<Equal<Index['tables']['products']['actions']['read'], 'crm.read' | 'catalog.read'>>,
	Expect<Equal<keyof RowOf<typeof tables, 'products', 'crm.read'>, 'id' | 'name' | 'cost'>>,
	Expect<Equal<keyof RowOf<typeof tables, 'products', 'catalog.read'>, 'id' | 'name'>>,
	Expect<Equal<keyof RowOf<typeof tables, 'products'>, 'id' | 'name'>>,
]
