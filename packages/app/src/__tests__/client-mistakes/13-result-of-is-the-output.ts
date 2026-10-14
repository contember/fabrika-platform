import { createClient, type ResultOf } from '@fabrika/app/client'
import { contract } from '../fixtures/kit-files/fabrika.contract'

const api = createClient(contract, 'api')

// mistake: attached answers a count
export const count: ResultOf<typeof api.notes.attached> = { files: 'one' }
