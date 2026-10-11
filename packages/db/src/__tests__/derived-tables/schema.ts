// The schema, column list and vocabulary the derived-tables suite and its type mistakes share, and the policies in
// the derived form: every key, container and child chain left to the vocabulary and the conventions.

import type { TypedColumnList, VocabularyPolicyMap } from '../../vocabulary-tables'

export interface DB {
	workspaces: { id: string; name: string }
	notes: { id: string; workspace_id: string; title: string; version: number }
	note_comments: { id: string; note_id: string; workspace_id: string; body: string }
	/** Off the convention: a folder lies in a workspace through `space_id`. */
	folders: { id: string; space_id: string; name: string }
	/** No `id` column, so the policy names its key. */
	tags: { code: string; workspace_id: string; label: string }
	/** Off the convention: a link is a child of a note through `parent_note`. */
	note_links: { id: string; parent_note: string; workspace_id: string; url: string }
}

export const columns: TypedColumnList<DB> = {
	workspaces: { columns: ['id', 'name'], foreignKeys: [] },
	notes: {
		columns: ['id', 'workspace_id', 'title', 'version'],
		foreignKeys: [{ columns: ['workspace_id'], table: 'workspaces', references: ['id'] }],
	},
	note_comments: {
		columns: ['id', 'note_id', 'workspace_id', 'body'],
		foreignKeys: [{ columns: ['note_id', 'workspace_id'], table: 'notes', references: ['id', 'workspace_id'] }],
	},
	folders: { columns: ['id', 'space_id', 'name'], foreignKeys: [{ columns: ['space_id'], table: 'workspaces', references: ['id'] }] },
	tags: { columns: ['code', 'workspace_id', 'label'], foreignKeys: [{ columns: ['workspace_id'], table: 'workspaces', references: ['id'] }] },
	note_links: {
		columns: ['id', 'parent_note', 'workspace_id', 'url'],
		foreignKeys: [{ columns: ['parent_note', 'workspace_id'], table: 'notes', references: ['id', 'workspace_id'] }],
	},
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
export const noteLinks = { scope: { child: 'notes', column: 'parent_note' }, actions: { read: 'notes.read' } } as const

export const derived = { workspaces, notes, note_comments: noteComments, folders, tags, note_links: noteLinks }

/** The same policies under the exported map type, as an application that annotates them writes them. */
export const annotated: VocabularyPolicyMap<DB, typeof vocabulary> = derived
