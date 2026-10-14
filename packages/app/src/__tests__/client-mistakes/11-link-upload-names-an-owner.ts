import { createClient } from '@fabrika/app/client'
import { contract } from '../fixtures/kit-files/fabrika.contract'

const share = createClient(contract, 'share', { key: 'px_key' })

// mistake: a link holder's owner is the link's object, never a parameter
export const uploaded = share.files.documents.upload('a-note-id', new Blob([]))
