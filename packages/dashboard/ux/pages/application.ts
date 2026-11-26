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
		{
			id: 'policy',
			label: 'What lets a change through',
			kind: 'section',
			usedBy: ['t06-approvals'],
			consequence: 2,
			audience: 'role',
			placement: 'primary',
		},
	],
}

// The rules editor of one environment: no main task edits the rules, so its elements serve none; the page still takes the gates.
export const applicationApprovalsEdit: PageSpec = {
	id: 'application-approvals-edit',
	path: '/apps/notes/approvals/prod/edit',
	elements: [
		...frame,
		{ id: 'rules', label: 'What lets a change through on prod', kind: 'section', usedBy: [], consequence: 1, audience: 'role', placement: 'primary' },
		{ id: 'presets', label: 'Start from a preset', kind: 'region', usedBy: [], consequence: 1, audience: 'role', placement: 'primary' },
		{ id: 'save', label: 'Save approvals', kind: 'action', usedBy: [], consequence: 1, audience: 'role', placement: 'primary' },
	],
}

export const applicationSecrets: PageSpec = {
	id: 'application-secrets',
	path: '/apps/notes/secrets',
	elements: [
		...frame,
		{ id: 'secrets', label: 'Secrets', kind: 'section', usedBy: ['t05-rotate-secret'], consequence: 2, audience: 'role', placement: 'primary' },
		{ id: 'variables', label: 'Variables', kind: 'section', usedBy: [], consequence: 1, audience: 'role', placement: 'secondary' },
	],
}

export const applicationAccess: PageSpec = {
	id: 'application-access',
	path: '/apps/notes/access/prod',
	elements: [
		...frame,
		{
			id: 'self-admin',
			label: 'Your admin access',
			kind: 'section',
			usedBy: ['t08-grant-self'],
			consequence: 2,
			audience: 'role',
			placement: 'secondary',
		},
		{ id: 'endpoints', label: 'Endpoints', kind: 'section', usedBy: ['t07-reach'], consequence: 2, audience: 'all', placement: 'primary' },
		{ id: 'roles', label: 'Roles', kind: 'section', usedBy: ['t07-reach'], consequence: 1, audience: 'all', placement: 'secondary' },
		{ id: 'off-road', label: 'Off the paved road', kind: 'section', usedBy: [], consequence: 1, audience: 'all', placement: 'secondary' },
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
