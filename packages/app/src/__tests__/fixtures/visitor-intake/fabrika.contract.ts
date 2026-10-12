// The public intake recipe (WU15): a public landing page, a registration form and a resend form that append and
// answer a constant, the intake job that `issues` links of the `portal` mount, and the candidates' attachments, which a
// link holder uploads and downloads for its own record.

import { app } from './src/app-kit'
import { intake } from './src/intake/endpoints'
import { portal, review } from './src/portal/endpoints'
import { Register, Resend } from './src/schemas'

export const contract = app.contract((c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true } }),
	register: c.form('/register', { input: Register, appendTo: 'registrations', maxBytes: 2048 }),
	resend: c.form('/resend', { input: Resend, appendTo: 'resend_requests', maxBytes: 1024 }),
	portal,
	review,
	files: {
		attachments: c.files({
			owner: 'candidates',
			read: 'candidates.read',
			write: 'candidates.attach',
			delete: 'candidates.process',
			maxBytes: 65536,
			types: ['application/pdf'],
			maxPerOwner: 3,
			link: true,
		}),
	},
	jobs: { intake },
}))
