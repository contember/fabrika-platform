import { groupMount } from '@fabrika/app/client'
import type { contract } from '../kit-fixture/fabrika.contract'

// mistake: a prefix is a path, which starts with a slash
export const api = groupMount<typeof contract>()('api', { app: 'crm', prefix: 'api' })
