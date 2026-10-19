// The public intake recipe: a public landing page, a registration and a resend procedure that write a row and answer a
// constant, the intake job that `issues` links of the `portal` mount, and the candidates' attachments, which a link
// holder uploads and downloads for its own record.

import { app } from './src/app-kit'
import { intake } from './src/intake/endpoints'
import { visitors } from './src/intake/visitors'
import { portal, review } from './src/portal/endpoints'

export const contract = app.contract((c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
	api: c.rpc('/api', { visitors }),
	portal,
	review,
	files: {
		attachments: c.files({ maxBytes: 65536, types: ['application/pdf'] }),
	},
	jobs: { intake },
}))
