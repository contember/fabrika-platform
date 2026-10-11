import { describe, expect, test } from 'bun:test'
import { PolicyError } from '../errors'
import { modelOf, readTables, tableModels } from '../policy'
import { tables } from './fixtures/tables'

// The refusals run on values nobody type-checked, through `readTables`: the parse `defineTables` runs.

const vocabulary = { dimensions: { workspace: {}, note: { in: 'workspace' } }, actions: {} }

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

const define = (columnList: unknown, policies: unknown) => readTables(columnList, policies, vocabulary)

describe('defineTables refuses a policy it cannot enforce', () => {
	test('a column the column list does not have', () => {
		const stale = { ...columns, notes: ['id', 'title', 'version', 'created_by'] as const }
		expect(() => define(stale, { notes, note_comments: comments, countries })).toThrow(
			'notes: scope.in.column names workspace_id, which is not a column (columns: id, title, version, created_by)',
		)
	})

	test('a table of the column list without a policy', () => {
		const extra = { ...columns, audit: ['id'] }
		expect(() => define(extra, { notes, note_comments: comments, countries })).toThrow('audit: every table needs a policy')
	})

	test('a stamped column in insert or update', () => {
		for (const stamped of ['id', 'workspace_id', 'version', 'created_by'] as const) {
			expect(() => define(columns, { notes: { ...notes, update: [stamped] }, note_comments: comments, countries })).toThrow(
				`${stamped} is stamped by the layer`,
			)
		}
		const childStamp = { ...comments, insert: ['workspace_id'] } as const
		expect(() => define(columns, { notes, note_comments: childStamp, countries })).toThrow('workspace_id is stamped by the layer')
	})

	test("a child that does not inherit its parent's container column", () => {
		const orphan = { ...comments, scope: { ...comments.scope, inherit: [] } }
		expect(() => define(columns, { notes, note_comments: orphan, countries })).toThrow(
			'must inherit exactly the containment columns of notes (workspace_id)',
		)
	})

	test('a child of a table that is not a dimension table', () => {
		const misparented = { ...comments, scope: { ...comments.scope, child: 'countries', inherit: [] } } as const
		expect(() => define(columns, { notes, note_comments: misparented, countries })).toThrow(
			'the parent countries must be a dimension table',
		)
	})

	test('two tables owning one dimension', () => {
		const twin = { scope: { dimension: 'note', key: 'code', in: { column: 'name' } }, actions: { read: 'notes.read' } } as const
		expect(() => define(columns, { notes, note_comments: comments, countries: twin })).toThrow(
			'dimension note is already owned by notes',
		)
	})

	test('a key with its own read action', () => {
		expect(() => define(columns, { notes: { ...notes, columns: { id: { read: 'notes.admin' } } }, note_comments: comments, countries })).toThrow(
			'the key id cannot have its own read action',
		)
	})

	test('an empty action name', () => {
		expect(() => define(columns, { notes: { ...notes, actions: { read: '' } }, note_comments: comments, countries })).toThrow(
			PolicyError,
		)
	})
})

describe('a column holds at most one stamped role', () => {
	const stampedColumns = {
		tenants: ['id'],
		items: ['id', 'tenant_id', 'version', 'created_by', 'title'],
		docs: ['id', 'item_id', 'tenant_id', 'version'],
		item_notes: ['id', 'item_id', 'tenant_id', 'body'],
	} as const
	const tenants = { scope: { dimension: 'tenant', key: 'id' }, actions: { read: 'read' } } as const
	const items = {
		scope: { dimension: 'item', key: 'id', in: { dimension: 'tenant', column: 'tenant_id' } },
		actions: { read: 'read', insert: 'write', update: 'write' },
		update: ['title'],
		version: 'version',
		createdBy: 'created_by',
	} as const
	const docs = {
		scope: { dimension: 'doc', key: 'id', in: { dimension: 'item', column: 'item_id' } },
		actions: { read: 'read', update: 'write' },
		version: 'version',
	} as const
	const itemNotes = {
		scope: { child: 'items', key: 'id', column: 'item_id', inherit: ['tenant_id'] },
		actions: { read: 'read', insert: 'write' },
		insert: ['body'],
	} as const
	const stamped = { tenants, items, docs, item_notes: itemNotes }
	const stampedVocabulary = { dimensions: { tenant: {}, item: { in: 'tenant' }, doc: { in: 'item' } }, actions: {} }
	const define = (policies: unknown) => readTables(stampedColumns, policies, stampedVocabulary)

	test('distinct stamped columns are accepted', () => {
		expect(modelOf(tableModels(define(stamped)), 'docs')?.chain).toEqual([
			{ dimension: 'item', column: 'item_id' },
			{ dimension: 'tenant', column: 'tenant_id' },
		])
	})

	test('the version on the key', () => {
		expect(() => define({ ...stamped, items: { ...items, version: 'id' } })).toThrow('items: id is both the key and the version')
	})

	test('createdBy on the key', () => {
		expect(() => define({ ...stamped, items: { ...items, createdBy: 'id' } })).toThrow('items: id is both the key and createdBy')
	})

	test('the version on the containment column', () => {
		expect(() => define({ ...stamped, items: { ...items, version: 'tenant_id' } })).toThrow(
			'items: tenant_id is both the tenant containment column and the version',
		)
	})

	test('createdBy on the containment column', () => {
		expect(() => define({ ...stamped, items: { ...items, createdBy: 'tenant_id' } })).toThrow(
			'items: tenant_id is both the tenant containment column and createdBy',
		)
	})

	test('the version on an ancestor column the scope does not name', () => {
		expect(() => define({ ...stamped, docs: { ...docs, version: 'tenant_id' } })).toThrow(
			'docs: tenant_id is both the tenant containment column and the version',
		)
	})

	test('the version and createdBy on one column', () => {
		expect(() => define({ ...stamped, items: { ...items, createdBy: 'version' } })).toThrow('items: version is both the version and createdBy')
	})

	test('the key as its own containment column', () => {
		const contained = { ...items, scope: { dimension: 'item', key: 'id', in: { dimension: 'tenant', column: 'id' } } } as const
		expect(() => define({ ...stamped, items: contained })).toThrow('items: id is both the key and the tenant containment column')
	})

	test("a child's key as its parent column", () => {
		const child = { ...itemNotes, scope: { ...itemNotes.scope, key: 'item_id' } } as const
		expect(() => define({ ...stamped, item_notes: child })).toThrow('item_notes: item_id is both the key and the item containment column')
	})

	test("a child's key as an inherited column", () => {
		const child = { ...itemNotes, scope: { ...itemNotes.scope, key: 'tenant_id' } } as const
		expect(() => define({ ...stamped, item_notes: child })).toThrow('item_notes: tenant_id is both the key and the tenant containment column')
	})

	test('an inherited column listed twice', () => {
		const child = { ...itemNotes, scope: { ...itemNotes.scope, inherit: ['tenant_id', 'tenant_id'] } } as const
		expect(() => define({ ...stamped, item_notes: child })).toThrow('item_notes: must inherit exactly the containment columns of items (tenant_id)')
	})
})

describe('policy arrays are read as plain arrays', () => {
	test('an array with its own map is refused; the map never runs', () => {
		const update: 'title'[] = ['title']
		Object.defineProperty(update, 'map', { value: () => ['workspace_id'] })
		expect(() => define(columns, { notes: { ...notes, update }, note_comments: comments, countries })).toThrow(
			'notes: update takes a plain array of column names',
		)
	})
})

describe('every row carries its whole containment chain', () => {
	const deepColumns = {
		organizations: ['id'],
		workspaces: ['id', 'organization_id'],
		notes: ['id', 'workspace_id', 'organization_id', 'title', 'version', 'created_by'],
		note_comments: ['id', 'note_id', 'workspace_id', 'organization_id', 'body'],
		countries: ['code', 'name'],
	} as const
	const organizations = { scope: { dimension: 'organization', key: 'id' }, actions: { read: 'notes.read' } } as const
	const workspaces = {
		scope: { dimension: 'workspace', key: 'id', in: { dimension: 'organization', column: 'organization_id' } },
		actions: { read: 'notes.read' },
	} as const
	const deepComments = { ...comments, scope: { ...comments.scope, inherit: ['workspace_id', 'organization_id'] } } as const
	const deep = { organizations, workspaces, notes, note_comments: deepComments, countries }
	const deepVocabulary = { dimensions: { organization: {}, workspace: { in: 'organization' }, note: { in: 'workspace' } }, actions: {} }
	const defineDeep = (columnList: unknown, policies: unknown, dimensions: unknown = deepVocabulary.dimensions) =>
		readTables(columnList, policies, { dimensions, actions: {} })

	test('the chains are resolved through the tables that own each dimension', () => {
		const models = tableModels(defineDeep(deepColumns, deep))
		expect(modelOf(models, 'notes')?.chain).toEqual([
			{ dimension: 'workspace', column: 'workspace_id' },
			{ dimension: 'organization', column: 'organization_id' },
		])
		expect(modelOf(models, 'note_comments')?.chain).toEqual([
			{ dimension: 'note', column: 'note_id' },
			{ dimension: 'workspace', column: 'workspace_id' },
			{ dimension: 'organization', column: 'organization_id' },
		])
	})

	test('a table without a column for an ancestor is refused', () => {
		const shallow = { ...deepColumns, notes: ['id', 'workspace_id', 'title', 'version', 'created_by'] as const }
		expect(() => defineDeep(shallow, deep)).toThrow('notes: must carry organization_id, because it lies in organization')
	})

	test('a child that inherits only part of its parent chain is refused', () => {
		expect(() => defineDeep(deepColumns, { ...deep, note_comments: comments })).toThrow(
			'must inherit exactly the containment columns of notes (workspace_id, organization_id)',
		)
	})

	test('an ancestor column is stamped and cannot be written', () => {
		const writable = { ...notes, update: ['organization_id'] } as const
		expect(() => defineDeep(deepColumns, { ...deep, notes: writable })).toThrow('organization_id is stamped by the layer')
	})

	test('a containment cycle is refused', () => {
		const looping = { ...organizations, scope: { dimension: 'organization', key: 'id', in: { column: 'id' } } } as const
		const cyclic = { ...deepVocabulary.dimensions, organization: { in: 'workspace' } }
		expect(() => defineDeep(deepColumns, { ...deep, organizations: looping }, cyclic)).toThrow('its containment is a cycle')
	})
})

describe('the parsed model', () => {
	test('a column with its own read action is left out; one with the table read action stays', () => {
		const notesModel = modelOf(tableModels(tables), 'notes')
		expect(notesModel?.visible).toEqual(['id', 'workspace_id', 'organization_id', 'title', 'body', 'word_count', 'created_by', 'version', 'created_at'])
		expect(notesModel?.scope).toEqual({
			mode: 'dimension',
			dimension: 'note',
			key: 'id',
			container: { dimension: 'workspace', column: 'workspace_id' },
		})
	})

	test('reference and inbox tables keep their mode and read action', () => {
		const models = tableModels(tables)
		expect(modelOf(models, 'countries')?.scope).toEqual({ mode: 'reference', reason: 'read-only lookup data' })
		expect(modelOf(models, 'contact_messages')?.scope).toEqual({ mode: 'inbox', form: 'contact' })
		expect(modelOf(models, 'contact_messages')?.actions.read).toBe('contact.read')
	})
})
