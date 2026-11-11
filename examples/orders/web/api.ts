// The typed client of the `/api` mount, and the answer types the screens read.

import { createClient } from '@fabrika/app/client'
import type { PageAnswer, ProcedureResult } from '@fabrika/app/react'
import { contract } from '../fabrika.contract'

export const api = createClient(contract, 'api', { bounceOnAuth: true })

type ItemOf<P> = P extends PageAnswer<infer Item> ? Item : never

export type Order = ItemOf<ProcedureResult<typeof api.orders.list>>
export type Customer = ItemOf<ProcedureResult<typeof api.customers.list>>
export type Rep = ProcedureResult<typeof api.customers.reps>['items'][number]
export type BillingRecord = ProcedureResult<typeof api.billing.list>['items'][number]
