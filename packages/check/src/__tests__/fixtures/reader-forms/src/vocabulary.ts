// The vocabulary consts the contract imports: a default export, an export alias and a const defined through another.

const readAction = 'tasks.read'

export const READ = readAction

const vocabularyActions = {
	'tasks.read': 'Read tasks',
	'tasks.write': `Create and edit tasks`,
	'tasks.delete': 'Delete tasks',
	'tasks.share': 'Share a task',
	'tasks.admin': 'Manage the project and its members',
	'projects.create': 'Start a project',
	'inbox.read': 'Read the feedback inbox',
} as const

export { vocabularyActions as actions }

export default {
	starter: { grants: ['projects.create'] },
	support: { grants: ['inbox.read'] },
	maintainer: {
		grants: ['tasks.read', 'tasks.write', 'tasks.delete', 'tasks.share', 'tasks.admin'],
		member: { scope: 'project', assignableBy: ['maintainer'] },
	},
	contributor: { grants: ['tasks.read', 'tasks.write'], member: { scope: 'project', assignableBy: ['maintainer'] } },
} as const
