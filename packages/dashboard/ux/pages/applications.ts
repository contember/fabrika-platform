import type { PageSpec } from '../checks/types'

// The Applications list, where every task starts: the row that opens notes and each environment's state.

export const applicationList: PageSpec = {
	id: 'application-list',
	path: '/apps',
	elements: [
		{
			id: 'app',
			label: 'App',
			kind: 'column',
			usedBy: [
				't01-environment-state',
				't02-deploy',
				't03-incident',
				't04-backups',
				't05-rotate-secret',
				't06-approvals',
				't07-reach',
				't08-grant-self',
				't09-environment-form',
				't10-builder',
				't11-errors',
			],
			consequence: 1,
			audience: 'all',
			placement: 'primary',
		},
		{
			id: 'state',
			label: 'State',
			kind: 'column',
			usedBy: ['t01-environment-state', 't03-incident'],
			consequence: 2,
			audience: 'all',
			placement: 'primary',
		},
	],
}
