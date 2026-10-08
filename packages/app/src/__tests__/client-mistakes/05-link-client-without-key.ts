import { createClient } from '@fabrika/app/client'
import { contract } from '../fixtures/notes-app/fabrika.contract'

// mistake: a link client presents the share key on every request
export const shared = createClient(contract, 'shared')
