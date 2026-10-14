import { createClient } from '@fabrika/app/client'
import { contract } from '../fixtures/kit-files/fabrika.contract'

const share = createClient(contract, 'share', { key: 'px_key' })

// mistake: attachments does not declare link: true
export const listed = share.files.attachments.list()
