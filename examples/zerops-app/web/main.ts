// The SPA: the notes the signed-in person may read, through the typed client of the `/api` mount. It imports the
// contract and the shared schemas only; the SPA build loads the contract without its handlers.

import { createClient } from '@fabrika/app/client'
import { contract } from '../fabrika.contract'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_NOTE } from '../src/schemas'

const api = createClient(contract, 'api', { bounceOnAuth: true })

const show = async (): Promise<void> => {
	const list = document.getElementById('notes')
	const limits = document.getElementById('limits')
	if (list === null || limits === null) return
	for (const note of (await api.notes.list()).items) {
		const item = document.createElement('li')
		item.textContent = note.trashed ? `${note.title} (in the trash)` : note.title
		list.append(item)
	}
	limits.textContent = `Up to ${MAX_ATTACHMENTS_PER_NOTE} attachments of at most ${MAX_ATTACHMENT_BYTES / 1048576} MiB per note.`
}

await show()
