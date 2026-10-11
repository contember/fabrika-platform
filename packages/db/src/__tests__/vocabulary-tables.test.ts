// The vocabulary form of `defineTables` at runtime: until containment is derived from the vocabulary, a policy states
// it, and the parse refuses one that omits it or contradicts the vocabulary instead of treating a table as top-level.

import { describe, expect, test } from 'bun:test'
import { modelOf, readTables, tableModels } from '../policy'
import { defineTables, type TypedColumnList } from '../tables'

interface DB {
	workspaces: { id: string; name: string }
	notes: { id: string; workspace_id: string; title: string }
	note_comments: { id: string; note_id: string; workspace_id: string; body: string }
}

const columns: TypedColumnList<DB> = {
	workspaces: ['id', 'name'],
	notes: ['id', 'workspace_id', 'title'],
	note_comments: ['id', 'note_id', 'workspace_id', 'body'],
}

const vocabulary = {
	app: 'notes',
	dimensions: { workspace: {}, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: {},
} as const

describe('defineTables(vocabulary, columns)', () => {
	test('takes policies that state their containment, as the vocabulary has it', () => {
		const tables = defineTables(vocabulary, columns)({
			workspaces: { scope: { dimension: 'workspace', key: 'id' }, actions: { read: 'notes.read' } },
			notes: {
				scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
				actions: { read: 'notes.read', insert: 'notes.write' },
				insert: ['title'],
			},
			note_comments: {
				scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id'] },
				actions: { read: 'notes.read' },
			},
		})
		expect(modelOf(tableModels(tables), 'notes')?.chain).toEqual([{ dimension: 'workspace', column: 'workspace_id' }])
	})

	test('refuses a key, a container or a child chain it would have to derive', () => {
		const define = defineTables(vocabulary, columns)
		const workspaces = { scope: { dimension: 'workspace', key: 'id' }, actions: { read: 'notes.read' } } as const
		const comments = { scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id'] }, actions: { read: 'notes.read' } } as const
		const notes = {
			scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
			actions: { read: 'notes.read' },
		} as const
		expect(() => define({ workspaces: { scope: { dimension: 'workspace' }, actions: { read: 'notes.read' } }, notes, note_comments: comments }))
			.toThrow(
				'workspaces: deriving scope.key from the vocabulary is not implemented (WU2); state it in the policy',
			)
		expect(() => define({ workspaces, notes: { scope: { dimension: 'note', key: 'id' }, actions: { read: 'notes.read' } }, note_comments: comments }))
			.toThrow('notes: deriving the container of note (scope.in) from the vocabulary is not implemented (WU2)')
		expect(() =>
			define({
				workspaces,
				notes: { scope: { dimension: 'note', key: 'id', in: { column: 'workspace_id' } }, actions: { read: 'notes.read' } },
				note_comments: comments,
			})
		).toThrow('notes: deriving the container of note (scope.in) from the vocabulary is not implemented (WU2)')
		expect(() => define({ workspaces, notes, note_comments: { scope: { child: 'notes' }, actions: { read: 'notes.read' } } })).toThrow(
			'note_comments: deriving scope.key from the vocabulary is not implemented (WU2)',
		)
	})

	test('refuses containment the vocabulary contradicts, read from values the types never saw', () => {
		const contradicting = { app: 'notes', dimensions: { workspace: {}, note: {} }, actions: { 'notes.read': 'Read notes' }, roles: {} } as const
		const workspaces = { scope: { dimension: 'workspace', key: 'id' }, actions: { read: 'notes.read' } } as const
		const comments = { scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id'] }, actions: { read: 'notes.read' } } as const
		const notes = { scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } }, actions: { read: 'notes.read' } }
		expect(() => readTables(columns, { workspaces, notes, note_comments: comments }, contradicting)).toThrow(
			'notes: the vocabulary puts note in no container, so scope.in is not a field here',
		)
		expect(() =>
			readTables(columns, { workspaces, notes, note_comments: comments }, { ...vocabulary, dimensions: { workspace: {}, note: { in: 'note' } } })
		)
			.toThrow('notes: the vocabulary puts note in note, not in workspace')
	})
})
