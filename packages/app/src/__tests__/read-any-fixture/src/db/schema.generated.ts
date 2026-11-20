import type { TypedColumnList } from '@fabrika/db'

export interface NoticesTable {
	id: string
	body: string
	internal: string
	created_by: string
}

export interface NotesTable {
	id: string
	workspace_id: string
	title: string
	created_by: string
	version: number
}

export interface DB {
	notices: NoticesTable
	notes: NotesTable
}

export const columns: TypedColumnList<DB> = {
	notices: { columns: ['id', 'body', 'internal', 'created_by'], foreignKeys: [] },
	notes: { columns: ['id', 'workspace_id', 'title', 'created_by', 'version'], foreignKeys: [] },
}
