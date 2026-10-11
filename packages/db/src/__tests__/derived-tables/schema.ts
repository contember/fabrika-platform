// The schema, column list and vocabulary the derived-tables suite and its type mistakes share, and the policies in
// the derived form: every key, container and child chain left to the vocabulary and the conventions.

import type { TypedColumnList } from '../../vocabulary-tables'

export interface DB {
	workspaces: { id: string; name: string }
	notes: { id: string; workspace_id: string; title: string; version: number }
	note_comments: { id: string; note_id: string; workspace_id: string; body: string }
	/** Off the convention: a folder lies in a workspace through `space_id`. */
	folders: { id: string; space_id: string; name: string }
	/** No `id` column, so the policy names its key. */
	tags: { code: string; workspace_id: string; label: string }
}

export const columns: TypedColumnList<DB> = {
	workspaces: ['id', 'name'],
	notes: ['id', 'workspace_id', 'title', 'version'],
	note_comments: ['id', 'note_id', 'workspace_id', 'body'],
	folders: ['id', 'space_id', 'name'],
	tags: ['code', 'workspace_id', 'label'],
}

export const vocabulary = {
	app: 'notes',
	dimensions: { workspace: {}, note: { in: 'workspace' }, folder: { in: 'workspace' }, tag: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: {},
} as const

export const workspaces = { scope: { dimension: 'workspace' }, actions: { read: 'notes.read' } } as const
export const notes = {
	scope: { dimension: 'note' },
	actions: { read: 'notes.read', update: 'notes.write' },
	update: ['title'],
	version: 'version',
} as const
export const noteComments = { scope: { child: 'notes' }, actions: { read: 'notes.read', insert: 'notes.write' }, insert: ['body'] } as const
export const folders = { scope: { dimension: 'folder', in: { column: 'space_id' } }, actions: { read: 'notes.read' } } as const
export const tags = { scope: { dimension: 'tag', key: 'code' }, actions: { read: 'notes.read' } } as const

export const derived = { workspaces, notes, note_comments: noteComments, folders, tags }
