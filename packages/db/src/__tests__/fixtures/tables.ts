import { defineTables } from '../../policy'
import type { VocabularyAction } from '../../vocabulary-tables'
import { columns } from './schema'

/**
 * What `defineTables` reads of an application's `defineVocabulary` result. The policies below leave every key, container
 * and child chain to it and the conventions, so every suite runs on derived models.
 */
export const vocabulary = {
	app: 'notes',
	dimensions: { organization: {}, workspace: { in: 'organization' }, note: { in: 'workspace' }, secret: {} },
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Write notes',
		'notes.delete': 'Delete notes',
		'notes.export': 'Export every note',
		'notes.count': 'Count every note',
		'organizations.create': 'Start an organization',
		'workspaces.create': 'Create workspaces',
		'workspaces.admin': 'Administer workspaces',
		'secrets.admin': 'Administer secrets',
		'contact.read': 'Read the contact inbox',
		'settings.read': 'Read the settings',
		'settings.edit': 'Edit the settings',
	},
	roles: {},
} as const

export type Action = VocabularyAction<typeof vocabulary>

export const tables = defineTables(vocabulary, columns)({
	organizations: {
		scope: { dimension: 'organization' },
		actions: { read: 'notes.read', insert: 'organizations.create' },
		insert: ['name'],
	},
	workspaces: {
		scope: { dimension: 'workspace' },
		actions: { read: 'notes.read', insert: 'workspaces.create', update: 'workspaces.admin', delete: 'workspaces.admin' },
		insert: ['name'],
		update: ['name'],
		createdBy: 'created_by',
	},
	notes: {
		scope: { dimension: 'note' },
		actions: {
			read: 'notes.read',
			insert: 'notes.write',
			update: 'notes.write',
			delete: 'notes.delete',
			appRead: ['notes.export'],
			appCount: ['notes.count'],
		},
		insert: ['title', 'body', 'word_count', 'internal'],
		update: ['title', 'body', 'word_count'],
		version: 'version',
		createdBy: 'created_by',
		columns: { internal: { read: 'notes.delete' }, title: { read: 'notes.read' } },
	},
	note_comments: {
		scope: { child: 'notes' },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.write' },
		insert: ['body'],
		update: ['body'],
	},
	note_flags: {
		scope: { child: 'notes' },
		actions: { read: 'notes.delete', insert: 'notes.write' },
		insert: ['reason'],
	},
	secrets: {
		scope: { dimension: 'secret' },
		actions: { read: 'secrets.admin' },
	},
	settings: {
		scope: { app: 'settings an administrator edits' },
		actions: { read: 'settings.read', insert: 'settings.edit', update: 'settings.edit' },
		insert: ['value'],
		update: ['value'],
	},
	countries: { scope: { reference: 'read-only lookup data' }, actions: { read: 'notes.read' } },
	contact_messages: { scope: { inbox: 'contact', read: 'contact.read' } },
})
