// The handle types a query function takes as its parameter, pinned against what a handler's `ctx.db` holds. Part of
// the package typecheck.

import type { App, DbHandle, EndpointContext, KitTypes, ReferenceHandle } from '@fabrika/app/contract'
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
