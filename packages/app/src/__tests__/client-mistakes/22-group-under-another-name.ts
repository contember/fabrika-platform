import { createGroupClient, groupMount } from '@fabrika/app/client'
import type { contract } from '../kit-fixture/fabrika.contract'
import { deals } from '../kit-fixture/src/deals/endpoints'

const api = groupMount<typeof contract>()('api', { app: 'crm', prefix: '/api' })

// mistake: the contract mounts no group under this name
export const client = createGroupClient(api, { deal: deals })
