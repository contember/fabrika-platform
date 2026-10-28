import type { TypedColumnList } from '@fabrika/db'

export interface NotesTable {
	id: string
	workspace_id: string
	title: string
	created_by: string
	version: number
}

export interface DB {
	notes: NotesTable
}

export const columns: TypedColumnList<DB> = {
	notes: { columns: ['id', 'workspace_id', 'title', 'created_by', 'version'], foreignKeys: [] },
}
