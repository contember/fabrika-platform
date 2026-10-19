// A kit application whose notes hold files in two file columns: `documents` scans, `attachments` does not. Its
// handlers and jobs reach the files through the rows that reference them, and `ctx.files.open`.

import { app } from './src/app-kit'
import { erase, mail, notes, share } from './src/notes'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	share,
	files: {
		documents: c.files({ maxBytes: 4096, types: ['application/pdf'], scan: true }),
		attachments: c.files({ maxBytes: 4096, types: ['application/pdf', 'text/plain'] }),
	},
	jobs: { mail, erase },
}))
