import { createGroupClient, groupMount } from '@fabrika/app/client'
import type { contract } from '../kit-fixture/fabrika.contract'
import { deals } from '../kit-fixture/src/deals/endpoints'

const api = groupMount<typeof contract>()('api', { app: 'crm', prefix: '/api' })
const client = createGroupClient(api, { deals })

// mistake: a group the client was not given
export const countries = client.companies.countries()
