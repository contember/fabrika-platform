import type { PageElement, PageSpec } from '../checks/types'

// The application page of the seeded `notes`: its frame and the tabs the main tasks land on.

const tab = (label: string, usedBy: readonly string[]): PageElement => ({
	id: `tab-${label.toLowerCase().replaceAll(' ', '-')}`,
	label,
	kind: 'tab',
	usedBy,
	consequence: 1,
	audience: 'all',
	placement: 'secondary',
})

const frame: readonly PageElement[] = [
	{
		id: 'environment-states',
		label: 'Environments',
		kind: 'region',
		usedBy: ['t01-environment-state', 't03-incident'],
		consequence: 2,
		audience: 'all',
		placement: 'primary',
	},
	{
		id: 'tabs',
		label: 'Application',
		kind: 'region',
		usedBy: ['t04-backups', 't05-rotate-secret', 't06-approvals'],
		consequence: 1,
		audience: 'all',
		placement: 'primary',
	},
	tab('Overview', ['t01-environment-state']),
	tab('Data', ['t03-incident', 't04-backups']),
	tab('Secrets and variables', ['t05-rotate-secret']),
	tab('Access', ['t07-reach', 't08-grant-self']),
	tab('Approvals', ['t06-approvals']),
	tab('Settings', ['t09-environment-form', 't10-builder']),
]

export const applicationOverview: PageSpec = {
	id: 'application-overview',
	path: '/apps/notes',
	elements: [
		...frame,
		tab('Deploys', ['t02-deploy']),
		{
			id: 'environments',
			label: 'Environments',
			kind: 'section',
			usedBy: ['t01-environment-state', 't02-deploy', 't11-errors'],
			consequence: 2,
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
		{ id: 'running', label: 'Running', kind: 'column', usedBy: ['t01-environment-state'], consequence: 1, audience: 'all', placement: 'primary' },
		{ id: 'last-run', label: 'Last run', kind: 'column', usedBy: ['t02-deploy'], consequence: 1, audience: 'all', placement: 'secondary' },
		{ id: 'errors', label: 'Errors', kind: 'column', usedBy: ['t11-errors'], consequence: 1, audience: 'all', placement: 'secondary' },
		{
			id: 'waiting',
			label: 'Waiting for a decision',
			kind: 'section',
			usedBy: ['t01-environment-state', 't06-approvals'],
			consequence: 2,
			audience: 'role',
			placement: 'primary',
		},
		{ id: 'recent-runs', label: 'Recent runs', kind: 'section', usedBy: ['t02-deploy'], consequence: 0, audience: 'all', placement: 'secondary' },
	],
}

export const applicationData: PageSpec = {
	id: 'application-data',
	path: '/apps/notes/data/prod',
	elements: [
		...frame,
		{
			id: 'environment-switch',
			label: 'Environment',
			kind: 'region',
			usedBy: ['t03-incident'],
			consequence: 1,
			audience: 'all',
			placement: 'secondary',
		},
		{ id: 'backups', label: 'Backups', kind: 'section', usedBy: ['t04-backups'], consequence: 1, audience: 'all', placement: 'secondary' },
		{ id: 'operations', label: 'Operations', kind: 'section', usedBy: ['t03-incident'], consequence: 2, audience: 'all', placement: 'secondary' },
	],
}

export const applicationApprovals: PageSpec = {
	id: 'application-approvals',
	path: '/apps/notes/approvals',
	elements: [
		...frame,
		{
			id: 'waiting',
			label: 'Waiting for a decision',
			kind: 'section',
			usedBy: ['t06-approvals'],
			consequence: 2,
			audience: 'role',
			placement: 'primary',
		},
		{ id: 'policy', label: 'Access approvals', kind: 'section', usedBy: ['t06-approvals'], consequence: 2, audience: 'role', placement: 'primary' },
	],
}

export const applicationSettings: PageSpec = {
	id: 'application-settings',
	path: '/apps/notes/settings',
	elements: [
		...frame,
		{ id: 'build', label: 'Build config', kind: 'section', usedBy: ['t10-builder'], consequence: 1, audience: 'role', placement: 'secondary' },
		{
			id: 'environments',
			label: 'Environments',
			kind: 'section',
			usedBy: ['t09-environment-form'],
			consequence: 1,
			audience: 'role',
			placement: 'secondary',
		},
		{
			id: 'builder',
			label: 'Work locally with the builder',
			kind: 'section',
			usedBy: ['t10-builder'],
			consequence: 0,
			audience: 'role',
			placement: 'secondary',
		},
		{ id: 'delete', label: 'Delete app', kind: 'action', usedBy: [], consequence: 2, audience: 'role', placement: 'disclosed' },
	],
}
