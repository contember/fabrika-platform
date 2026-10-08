import { defineTables } from '../../policy'
import { columns, type DB } from './schema'

export type Action =
	| 'notes.read'
	| 'notes.write'
	| 'notes.delete'
	| 'organizations.create'
	| 'workspaces.create'
	| 'workspaces.admin'
	| 'secrets.admin'
	| 'contact.read'

export const tables = defineTables<DB, Action>(columns)({
	organizations: {
		scope: { dimension: 'organization', key: 'id' },
		actions: { read: 'notes.read', insert: 'organizations.create' },
		insert: ['name'],
	},
	workspaces: {
		scope: { dimension: 'workspace', key: 'id', in: { dimension: 'organization', column: 'organization_id' } },
		actions: { read: 'notes.read', insert: 'workspaces.create', update: 'workspaces.admin', delete: 'workspaces.admin' },
		insert: ['name'],
		update: ['name'],
		createdBy: 'created_by',
	},
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
		insert: ['title', 'body', 'word_count', 'internal'],
		update: ['title', 'body', 'word_count'],
		version: 'version',
		createdBy: 'created_by',
		columns: { internal: { read: 'notes.delete' }, title: { read: 'notes.read' } },
	},
	note_comments: {
		scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id', 'organization_id'] },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.write' },
		insert: ['body'],
		update: ['body'],
	},
	note_flags: {
		scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id', 'organization_id'] },
		actions: { read: 'notes.delete', insert: 'notes.write' },
		insert: ['reason'],
	},
	secrets: {
		scope: { dimension: 'secret', key: 'id' },
		actions: { read: 'secrets.admin' },
	},
	countries: { scope: { reference: 'read-only lookup data' }, actions: { read: 'notes.read' } },
	contact_messages: { scope: { inbox: 'contact', read: 'contact.read' } },
})
