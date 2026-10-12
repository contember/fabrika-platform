import { activities } from './src/activities/endpoints'
import { app } from './src/app-kit'
import { companies } from './src/companies/endpoints'
import { contacts } from './src/contacts/endpoints'
import { deals } from './src/deals/endpoints'
import { orgs } from './src/orgs/endpoints'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_DEAL } from './src/schemas'
import { overdue, tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { orgs, companies, contacts, deals, tasks, activities }),
	site: c.spa('/', { dir: 'dist/web', access: { action: 'crm.read', over: 'org' } }),
	files: {
		attachments: c.files({
			owner: 'deals',
			read: 'crm.read',
			write: 'deals.write',
			delete: 'crm.delete',
			maxBytes: MAX_ATTACHMENT_BYTES,
			types: ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'text/csv'],
			maxPerOwner: MAX_ATTACHMENTS_PER_DEAL,
		}),
	},
	jobs: { overdue },
	health: c.health('/healthz'),
}))
