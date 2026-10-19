// A kit application whose files are values in table columns (`stored-files.test.ts`).

import { app } from './src/app-kit'
import { attachments, catalog, catalogMail, intake, intakeMail, scans, shop } from './src/deals/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { attachments, catalog, shop, intake }),
	health: c.health('/healthz'),
	scans,
	jobs: { catalogMail, intakeMail },
	files: {
		attachments: c.files({ types: ['application/pdf', 'image/png'], maxBytes: 1048576 }),
		catalog: c.files({ types: ['image/png'], maxBytes: 262144 }),
		photos: c.files({ types: ['image/png'], maxBytes: 262144, scan: true }),
	},
}))
