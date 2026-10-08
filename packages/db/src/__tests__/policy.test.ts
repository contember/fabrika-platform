import { describe, expect, test } from 'bun:test'
import { PolicyError } from '../errors'
import { defineTables, tableModels } from '../policy'
import { tables } from './fixtures/tables'

interface Notes {
	id: string
	workspace_id: string
	title: string
	version: number
	created_by: string
}

interface Comments {
	id: string
	note_id: string
	workspace_id: string
	body: string
}

interface Countries {
	code: string
	name: string
}

interface DB {
	notes: Notes
	note_comments: Comments
	countries: Countries
}

const columns = {
	notes: ['id', 'workspace_id', 'title', 'version', 'created_by'],
	note_comments: ['id', 'note_id', 'workspace_id', 'body'],
	countries: ['code', 'name'],
} as const

const notes = {
	scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
	actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write' },
	insert: ['title'],
	update: ['title'],
	version: 'version',
	createdBy: 'created_by',
} as const

const comments = {
	scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id'] },
	actions: { read: 'notes.read' },
} as const

const countries = { scope: { reference: 'lookup data' }, actions: { read: 'notes.read' } } as const

describe('defineTables refuses a policy it cannot enforce', () => {
	test('a column the column list does not have', () => {
		const stale = { ...columns, notes: ['id', 'title', 'version', 'created_by'] as const }
		expect(() => defineTables<DB, string>(stale)({ notes, note_comments: comments, countries })).toThrow(
			'notes: scope.in.column names workspace_id, which is not a column (columns: id, title, version, created_by)',
		)
	})

	test('a table of the column list without a policy', () => {
		const extra = { ...columns, audit: ['id'] }
		expect(() => defineTables<DB, string>(extra)({ notes, note_comments: comments, countries })).toThrow('audit: every table needs a policy')
	})

	test('a stamped column in insert or update', () => {
		for (const stamped of ['id', 'workspace_id', 'version', 'created_by'] as const) {
			expect(() => defineTables<DB, string>(columns)({ notes: { ...notes, update: [stamped] }, note_comments: comments, countries })).toThrow(
				`${stamped} is stamped by the layer`,
			)
		}
		const childStamp = { ...comments, insert: ['workspace_id'] } as const
		expect(() => defineTables<DB, string>(columns)({ notes, note_comments: childStamp, countries })).toThrow('workspace_id is stamped by the layer')
	})

	test("a child that does not inherit its parent's container column", () => {
		const orphan = { ...comments, scope: { ...comments.scope, inherit: [] } }
		expect(() => defineTables<DB, string>(columns)({ notes, note_comments: orphan, countries })).toThrow('must inherit workspace_id from notes')
	})

	test('a child of a table that is not a dimension table', () => {
		const misparented = { ...comments, scope: { ...comments.scope, child: 'countries', inherit: [] } } as const
		expect(() => defineTables<DB, string>(columns)({ notes, note_comments: misparented, countries })).toThrow(
			'the parent countries must be a dimension table',
		)
	})

	test('two tables owning one dimension', () => {
		const twin = { scope: { dimension: 'note', key: 'code' }, actions: { read: 'notes.read' } } as const
		expect(() => defineTables<DB, string>(columns)({ notes, note_comments: comments, countries: twin })).toThrow(
			'dimension note is already owned by notes',
		)
	})

	test('a key with its own read action', () => {
		expect(() =>
			defineTables<DB, string>(columns)({ notes: { ...notes, columns: { id: { read: 'notes.admin' } } }, note_comments: comments, countries })
		).toThrow(
			'the key id cannot have its own read action',
		)
	})

	test('an empty action name', () => {
		expect(() => defineTables<DB, string>(columns)({ notes: { ...notes, actions: { read: '' } }, note_comments: comments, countries })).toThrow(
			PolicyError,
		)
	})
})

describe('the parsed model', () => {
	test('a column with its own read action is left out; one with the table read action stays', () => {
		const notesModel = tableModels(tables).get('notes')
		expect(notesModel?.visible).toEqual(['id', 'workspace_id', 'title', 'body', 'word_count', 'created_by', 'version', 'created_at'])
		expect(notesModel?.scope).toEqual({
			mode: 'dimension',
			dimension: 'note',
			key: 'id',
			container: { dimension: 'workspace', column: 'workspace_id' },
		})
	})

	test('reference and inbox tables keep their mode and read action', () => {
		const models = tableModels(tables)
		expect(models.get('countries')?.scope).toEqual({ mode: 'reference', reason: 'read-only lookup data' })
		expect(models.get('contact_messages')?.scope).toEqual({ mode: 'inbox', form: 'contact' })
		expect(models.get('contact_messages')?.actions.read).toBe('contact.read')
	})
})
