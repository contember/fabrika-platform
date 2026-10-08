// The application the generated isolation tests are written for: a top-level dimension table, two contained ones,
// a child table and a reference table, with a column read policy and a version column.

import { defineContract } from '@fabrika/app/contract'

export const contract = defineContract({
	app: 'isolation',
	dimensions: {
		organization: {},
		workspace: { in: 'organization' },
		note: { in: 'workspace' },
	},
	actions: {
		'organizations.read': 'Read organizations',
		'organizations.admin': 'Rename organizations',
		'workspaces.read': 'Read workspaces',
		'workspaces.write': 'Create and rename workspaces',
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.delete': 'Delete notes',
		'notes.admin': 'Read internal notes',
	},
	roles: {
		member: { grants: ['organizations.read', 'workspaces.read', 'notes.read', 'notes.write'] },
	},
}, (c) => ({
	health: c.health('/healthz'),
}))
