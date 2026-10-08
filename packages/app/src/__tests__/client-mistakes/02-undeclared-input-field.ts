import { createClient } from '@fabrika/app/client'
import { contract } from '../fixtures/implement/fabrika.contract'

const api = createClient(contract, 'api')

// mistake: the input is strict; ownerId is not a field of it
export const created = api.notes.create({ workspaceId: 'w1', title: 'x', ownerId: 'u1' })
