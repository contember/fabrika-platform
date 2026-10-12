import type { TypedColumnList } from '@fabrika/db'

export interface NotesTable {
	id: string
	workspace_id: string
	organization_id: string
	title: string
	trashed: boolean
	created_by: string
	version: number
}

export interface WorkspacesTable {
	id: string
	organization_id: string
	name: string
}

export interface DB {
	notes: NotesTable
	workspaces: WorkspacesTable
}

export const columns: TypedColumnList<DB> = {
	notes: {
		columns: ['id', 'workspace_id', 'organization_id', 'title', 'trashed', 'created_by', 'version'],
		foreignKeys: [{ columns: ['workspace_id', 'organization_id'], table: 'workspaces', references: ['id', 'organization_id'] }],
	},
	workspaces: { columns: ['id', 'organization_id', 'name'], foreignKeys: [] },
}
