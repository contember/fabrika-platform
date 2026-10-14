// A kit application whose handlers and jobs reach its file collections through `ctx.files`: `documents` scans and
// serves link holders, `attachments` does neither.

import { app } from './src/app-kit'
import { erase, mail, notes, peek, share } from './src/notes'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	share,
	files: {
		documents: c.files({
			owner: 'notes',
			read: 'notes.read',
			write: 'notes.write',
			delete: 'notes.delete',
			maxBytes: 4096,
			types: ['application/pdf'],
			scan: true,
			link: true,
		}),
		attachments: c.files({
			owner: 'notes',
			read: 'notes.read',
			write: 'notes.write',
			delete: 'notes.delete',
			maxBytes: 4096,
			types: ['application/pdf', 'text/plain'],
		}),
	},
	jobs: { mail, peek, erase },
}))
