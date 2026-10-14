// The handle types a query function takes as its parameter, pinned against what a handler's `ctx.db` holds. Part of
// the package typecheck.

import type { App, DbHandle, EndpointContext, KitTypes, ReferenceHandle, SqlHandle, SqlScope } from '@fabrika/app/contract'
import type { Ref, Within } from '@fabrika/app/implement'
import type { app } from './kit-fixture/src/app-kit'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type K = typeof app extends App<infer Kit extends KitTypes> ? Kit : never
type None = { readonly sql?: never; readonly unscoped?: never; readonly connect?: never; readonly issues?: never }
type Db<Kind extends 'query' | 'mutation', Acc> = EndpointContext<K, 'human', Kind, Acc, None>['db']

/** A query function whose parameter is `DbHandle<typeof app, …>` takes exactly the handle the handler holds. */
export type Handles = [
	Expect<
		Equal<DbHandle<typeof app, 'on', 'deal', 'deals.write', 'mutation'>, Db<'mutation', { action: 'deals.write'; on: 'deal'; from: 'id' }>['target']>
	>,
	Expect<Equal<DbHandle<typeof app, 'in', 'org', 'crm.read'>, Db<'query', { action: 'crm.read'; in: 'org'; from: 'orgId' }>['target']>>,
	Expect<Equal<DbHandle<typeof app, 'over', 'company', 'crm.read'>, Db<'query', { action: 'crm.read'; over: 'company' }>['within']>>,
	Expect<Equal<ReferenceHandle<typeof app>, Db<'query', { member: true }>['reference']>>,
]

type WithSql<M extends 'read' | 'write'> = { readonly sql?: M; readonly unscoped?: never; readonly connect?: never; readonly issues?: never }
type Sql<Kind extends 'query' | 'mutation', M extends 'read' | 'write', Acc> = EndpointContext<K, 'human', Kind, Acc, WithSql<M>>['sql']

/** A query function whose parameter is `SqlHandle<typeof app, …>` takes exactly the `ctx.sql` the handler holds. */
export type SqlHandles = [
	Expect<Equal<SqlHandle<typeof app, 'read'>, Sql<'query', 'read', { action: 'crm.read'; in: 'org'; from: 'orgId' }>>>,
	Expect<Equal<SqlHandle<typeof app, 'write'>, Sql<'mutation', 'write', { action: 'deals.write'; on: 'deal'; from: 'id' }>>>,
]

/** A helper typed by the app's own tables scopes a table for a literal capability. */
export const scopeDeals = (sql: SqlHandle<typeof app, 'read'>, org: Ref<'org', 'crm.read'>): SqlScope => sql.scope(org, 'deals', 'd')

/** On a `'write'` site the fragment of an UPDATE target takes the table's update action. */
export const scopeDealUpdate = (sql: SqlHandle<typeof app, 'write'>, within: Within<'company', 'deals.write'>): SqlScope => sql.scope(within, 'deals')

/** A `'write'` site's `ctx.sql` is assignable to a `'read'` helper's parameter. */
export const fromWriteSite = (sql: SqlHandle<typeof app, 'write'>, org: Ref<'org', 'crm.read'>): SqlScope => scopeDeals(sql, org)
