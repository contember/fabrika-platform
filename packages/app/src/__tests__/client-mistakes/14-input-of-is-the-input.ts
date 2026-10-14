import { createClient, type InputOf } from '@fabrika/app/client'
import { contract } from '../fixtures/kit-files/fabrika.contract'

const api = createClient(contract, 'api')

// mistake: submit takes the version the caller saw
export const input: InputOf<typeof api.notes.submit> = { id: 'a-note-id' }
