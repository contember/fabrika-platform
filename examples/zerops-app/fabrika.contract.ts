// Who may call what: the notes slice's endpoints and job, the guests a staff member invites, the attachments of a note
// and the file kind they hold, and the SPA. The proxy enforces this file's endpoint table and the data layer the
// policies of src/db/tables.ts.

import { app } from './src/app-kit'
import { attachments } from './src/attachments/endpoints'
import { guests } from './src/guests/endpoints'
import { notes, purge } from './src/notes/endpoints'
import { MAX_ATTACHMENT_BYTES } from './src/schemas'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes, attachments }),
	people: c.rpc('/people', { guests }),
	site: c.spa('/', { dir: 'dist/web', access: { action: 'notes.read', over: 'workspace' } }),
	files: {
		attachments: c.files({ maxBytes: MAX_ATTACHMENT_BYTES, types: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain'] }),
	},
	jobs: { purge },
	health: c.health('/healthz'),
}))
