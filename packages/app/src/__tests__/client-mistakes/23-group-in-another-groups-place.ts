import { createGroupClient, groupMount } from '@fabrika/app/client'
import type { contract } from '../kit-fixture/fabrika.contract'
import { companies } from '../kit-fixture/src/companies/endpoints'

const api = groupMount<typeof contract>()('api', { app: 'crm', prefix: '/api' })

// mistake: the contract mounts another group under `deals`
export const client = createGroupClient(api, { deals: companies })
