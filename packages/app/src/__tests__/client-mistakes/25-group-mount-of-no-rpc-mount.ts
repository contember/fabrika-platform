import { groupMount } from '@fabrika/app/client'
import type { contract } from '../kit-fixture/fabrika.contract'

// mistake: a mount that holds no groups
export const api = groupMount<typeof contract>()('shared', { app: 'crm', prefix: '/shared' })
