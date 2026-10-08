import { createClient } from '@fabrika/app/client'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

// mistake: a procedure the contract does not declare
export const dump = api.notes.adminDump()
