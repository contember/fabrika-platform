import { createClient } from '@fabrika/app/client'
import { contract } from '../fixtures/implement/fabrika.contract'

// mistake: a health mount has no procedures to call
export const health = createClient(contract, 'health')
