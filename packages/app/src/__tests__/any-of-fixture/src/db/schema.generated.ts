import type { TypedColumnList } from '@fabrika/db'

export interface DesksTable {
	id: string
	label: string
	status: string
	audit_note: string
	created_by: string
	version: number
}

export interface EntriesTable {
	id: string
	desk_id: string
	amount: number
	created_by: string
}

export interface DB {
	desks: DesksTable
	entries: EntriesTable
}

export const columns: TypedColumnList<DB> = {
	desks: { columns: ['id', 'label', 'status', 'audit_note', 'created_by', 'version'], foreignKeys: [] },
	entries: { columns: ['id', 'desk_id', 'amount', 'created_by'], foreignKeys: [] },
}
