// The typed client of the `/api` mount. The views name their calls by it; `FabrikaProvider` runs them on the client
// it holds, which a test replaces with one over the test kit.

import { createClient } from '@fabrika/app/client'
import type { PageAnswer, ProcedureResult } from '@fabrika/app/react'
import { contract } from '../fabrika.contract'

export const api = createClient(contract, 'api', { bounceOnAuth: true })

type ItemOf<P> = P extends PageAnswer<infer Item> ? Item : never

export type Deal = ProcedureResult<typeof api.deals.get>
export type Company = ProcedureResult<typeof api.companies.get>
export type Contact = ProcedureResult<typeof api.contacts.get>
export type Task = ItemOf<ProcedureResult<typeof api.tasks.list>>
export type Activity = ItemOf<ProcedureResult<typeof api.activities.ofDeal>>
export type Member = ProcedureResult<typeof api.orgs.members>['items'][number]
