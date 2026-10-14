import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	organizations: {
		scope: { dimension: 'organization', key: 'id' },
		actions: { read: 'organizations.read', update: 'organizations.admin' },
		update: ['name'],
	},
	workspaces: {
		scope: { dimension: 'workspace', key: 'id', in: { dimension: 'organization', column: 'organization_id' } },
		actions: { read: 'workspaces.read', insert: 'workspaces.write', update: 'workspaces.write' },
		insert: ['name'],
		update: ['name'],
	},
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
		insert: ['title', 'body', 'internal', 'pinned'],
		update: ['title', 'body', 'pinned'],
		version: 'version',
		createdBy: 'created_by',
		columns: { internal: { read: 'notes.admin' } },
	},
	note_comments: {
		scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id', 'organization_id'] },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.write' },
		insert: ['body'],
		update: ['body'],
	},
	workspace_events: {
		scope: { child: 'workspaces', key: 'id', column: 'workspace_id', inherit: ['organization_id'] },
		actions: { read: 'workspaces.read', insert: 'workspaces.admin', delete: 'workspaces.admin' },
		insert: ['summary'],
	},
	countries: { scope: { reference: 'lookup data' }, actions: { read: 'notes.read' } },
})
