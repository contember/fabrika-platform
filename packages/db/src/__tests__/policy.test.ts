import { describe, expect, test } from 'bun:test'
import { PolicyError } from '../errors'
import { modelOf, readTables, tableModels } from '../policy'
import { tables } from './fixtures/tables'

// The refusals run on values nobody type-checked, through `readTables`: the parse `defineTables` runs.

type Key = readonly [columns: readonly string[], table: string, references: readonly string[]]

/** A generated column list from each table's columns and its foreign keys. */
const listOf = (tables: Readonly<Record<string, readonly string[]>>, keys: Readonly<Record<string, readonly Key[]>>) =>
	Object.fromEntries(
		Object.entries(tables).map(([table, columns]) => [
			table,
			{ columns, foreignKeys: (keys[table] ?? []).map(([from, to, references]) => ({ columns: from, table: to, references })) },
		]),
	)

const actions = { 'notes.read': 'Read', 'notes.write': 'Write', 'notes.admin': 'Administer' }
const vocabulary = { dimensions: { workspace: {}, note: { in: 'workspace' } }, actions }
const keys: Readonly<Record<string, readonly Key[]>> = { note_comments: [[['note_id', 'workspace_id'], 'notes', ['id', 'workspace_id']]] }

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

const define = (columnList: Readonly<Record<string, readonly string[]>>, policies: unknown) =>
	readTables(listOf(columnList, keys), policies, vocabulary)

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
			'the key id takes no action of its own',
		)
	})

	test('a column policy on the key or the version, even the table read action: every capability reads both', () => {
		for (const column of ['id', 'version']) {
			expect(() => define(columns, { notes: { ...notes, columns: { [column]: { read: 'notes.read' } } }, note_comments: comments, countries }))
				.toThrow(`the ${column === 'id' ? 'key' : 'version'} ${column} takes no action of its own`)
		}
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
	const stampedVocabulary = { dimensions: { tenant: {}, item: { in: 'tenant' }, doc: { in: 'item' } }, actions: { read: 'Read', write: 'Write' } }
	const stampedKeys: Readonly<Record<string, readonly Key[]>> = {
		items: [[['tenant_id'], 'tenants', ['id']], [['id'], 'tenants', ['id']]],
		docs: [[['item_id', 'tenant_id'], 'items', ['id', 'tenant_id']]],
		item_notes: [[['item_id', 'tenant_id'], 'items', ['id', 'tenant_id']]],
	}
	const define = (policies: unknown) => readTables(listOf(stampedColumns, stampedKeys), policies, stampedVocabulary)

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
	const deepDimensions = { organization: {}, workspace: { in: 'organization' }, note: { in: 'workspace' } }
	const deepKeys: Readonly<Record<string, readonly Key[]>> = {
		workspaces: [[['organization_id'], 'organizations', ['id']]],
		notes: [[['workspace_id', 'organization_id'], 'workspaces', ['id', 'organization_id']]],
		note_comments: [[['note_id', 'workspace_id', 'organization_id'], 'notes', ['id', 'workspace_id', 'organization_id']]],
	}
	const defineDeep = (columnList: Readonly<Record<string, readonly string[]>>, policies: unknown, dimensions: unknown = deepDimensions) =>
		readTables(listOf(columnList, deepKeys), policies, { dimensions, actions })

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
		const shallowKeys: Readonly<Record<string, readonly Key[]>> = {
			...deepKeys,
			notes: [[['workspace_id'], 'workspaces', ['id']]],
			note_comments: [[['note_id', 'workspace_id'], 'notes', ['id', 'workspace_id']]],
		}
		expect(() => readTables(listOf(shallow, shallowKeys), deep, { dimensions: deepDimensions, actions })).toThrow(
			'notes: must carry organization_id, because it lies in organization',
		)
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

	test('a containment cycle in the vocabulary is refused', () => {
		const looping = { ...organizations, scope: { dimension: 'organization', key: 'id', in: { column: 'id' } } } as const
		const cyclic = { ...deepDimensions, organization: { in: 'workspace' } }
		expect(() => defineDeep(deepColumns, { ...deep, organizations: looping }, cyclic)).toThrow(
			"the vocabulary's containment is a cycle (organization → workspace → organization)",
		)
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
		expect(modelOf(models, 'contact_messages')?.actions.read).toEqual(['contact.read'])
	})
})

describe('an application table', () => {
	const settings = {
		scope: { app: 'settings an administrator edits' },
		actions: { read: 'notes.read', insert: 'notes.admin', update: 'notes.admin', delete: 'notes.admin' },
		insert: ['name'],
		update: ['name'],
		version: 'version',
		createdBy: 'created_by',
	}
	const withSettings = (policy: unknown, settingsColumns: readonly string[] = ['id', 'name', 'version', 'created_by']) =>
		define({ ...columns, settings: settingsColumns }, { notes, note_comments: comments, countries, settings: policy })

	test('lies in no dimension: its key defaults to id, and it carries no containment chain', () => {
		const model = modelOf(tableModels(withSettings(settings)), 'settings')
		expect(model?.scope).toEqual({ mode: 'app', reason: 'settings an administrator edits', key: 'id' })
		expect(model?.chain).toEqual([])
		expect(model?.actions).toEqual({
			read: ['notes.read'],
			insert: ['notes.admin'],
			update: ['notes.admin'],
			delete: ['notes.admin'],
			appRead: [],
			appCount: [],
		})
	})

	test('names its key off the convention, and refuses a field another scope takes', () => {
		const keyed = { ...settings, scope: { app: 'settings', key: 'code' } }
		expect(modelOf(tableModels(withSettings(keyed, ['code', 'name', 'version', 'created_by'])), 'settings')?.scope).toEqual({
			mode: 'app',
			reason: 'settings',
			key: 'code',
		})
		expect(() => withSettings({ ...settings, scope: { app: 'settings', dimension: 'workspace' } })).toThrow(PolicyError)
		expect(() => withSettings({ ...settings, scope: { app: '' } })).toThrow('settings: scope.app must be a non-empty string')
	})

	test('stamps its key like a dimension table: the key is never written, and takes no action of its own', () => {
		expect(() => withSettings({ ...settings, insert: ['id', 'name'] })).toThrow(
			'settings: id is stamped by the layer; remove it from insert and update',
		)
		expect(() => withSettings({ ...settings, columns: { id: { read: 'notes.admin' } } })).toThrow('settings: the key id takes no action of its own')
	})
})

describe('actions that reach every row app-wide besides the read action', () => {
	const vocabularyOf = { dimensions: vocabulary.dimensions, actions: { ...actions, 'notes.export': 'Export', 'notes.count': 'Count' } }
	const defineWith = (policies: unknown) => readTables(listOf(columns, keys), policies, vocabularyOf)
	const withActions = (extra: object, table: 'notes' | 'countries' = 'notes') =>
		defineWith({
			notes: table === 'notes' ? { ...notes, actions: { ...notes.actions, ...extra } } : notes,
			note_comments: comments,
			countries: table === 'countries' ? { ...countries, actions: { ...countries.actions, ...extra } } : countries,
		})

	test('a dimension or child table names actions that read every row (appRead) and that only count (appCount)', () => {
		const model = modelOf(tableModels(withActions({ appRead: ['notes.export'], appCount: ['notes.count'] })), 'notes')
		expect(model?.actions.appRead).toEqual(['notes.export'])
		expect(model?.actions.appCount).toEqual(['notes.count'])
		expect(modelOf(tableModels(withActions({})), 'notes')?.actions).toMatchObject({ appRead: [], appCount: [] })
		const child = defineWith({ notes, note_comments: { ...comments, actions: { read: 'notes.read', appCount: ['notes.count'] } }, countries })
		expect(modelOf(tableModels(child), 'note_comments')?.actions.appCount).toEqual(['notes.count'])
	})

	test('an action the vocabulary does not declare, the read action itself, one named twice or in both lists', () => {
		expect(() => withActions({ appRead: ['notes.exprot'] })).toThrow(
			'notes: actions.appRead names notes.exprot, which is not an action of the vocabulary',
		)
		expect(() => withActions({ appRead: ['notes.read'] })).toThrow(
			'notes: actions.appRead names notes.read, its read action, which reads every row app-wide already',
		)
		expect(() => withActions({ appCount: ['notes.count', 'notes.count'] })).toThrow('notes: actions.appCount names notes.count twice')
		expect(() => withActions({ appRead: ['notes.export'], appCount: ['notes.export'] })).toThrow(
			'notes: actions.appRead and actions.appCount both name notes.export',
		)
		expect(() => withActions({ appRead: [] })).toThrow('notes: actions.appRead lists no action; leave it out')
		expect(() => withActions({ appRead: 'notes.export' })).toThrow('notes: actions.appRead takes a plain array of actions')
	})

	test('a reference table takes neither: only a dimension or child table is read through ctx.db.app by another action', () => {
		expect(() => withActions({ appRead: ['notes.export'] }, 'countries')).toThrow(
			'countries: actions.appRead is for a dimension or child table; a reference table takes none',
		)
	})
})

test('an application table takes neither: its read action reads every row app-wide already', () => {
	const settings = { scope: { app: 'settings' }, actions: { read: 'notes.read', update: 'notes.admin', appRead: ['notes.write'] } }
	expect(() => define({ ...columns, settings: ['id', 'name'] }, { notes, note_comments: comments, countries, settings })).toThrow(
		'settings: actions.appRead is for a dimension or child table; an application table takes none',
	)
})

describe('a list of actions per table action', () => {
	const withNotes = (notesActions: unknown, extra: object = {}) =>
		define(columns, { notes: { ...notes, actions: notesActions, ...extra }, note_comments: comments, countries })

	test('each operation takes one action or a list of them; any one of them allows it', () => {
		const model = modelOf(
			tableModels(withNotes({ read: ['notes.read', 'notes.admin'], insert: 'notes.write', update: ['notes.write', 'notes.admin'] })),
			'notes',
		)
		expect(model?.actions).toMatchObject({
			read: ['notes.read', 'notes.admin'],
			insert: ['notes.write'],
			update: ['notes.write', 'notes.admin'],
			delete: [],
		})
	})

	test('a list is non-empty, of distinct actions of the vocabulary', () => {
		expect(() => withNotes({ read: [] })).toThrow('notes: actions.read lists no action; leave it out')
		expect(() => withNotes({ read: ['notes.read', 'notes.read'] })).toThrow('notes: actions.read names notes.read twice')
		expect(() => withNotes({ read: ['notes.read', 'notes.raed'] })).toThrow(
			'notes: actions.read names notes.raed, which is not an action of the vocabulary',
		)
		expect(() => withNotes({ read: 'notes.read', update: ['notes.write', ''] })).toThrow('notes: actions.update must be a non-empty string')
	})

	test('with several read actions, a column of one of them is hidden from every read', () => {
		const model = modelOf(
			tableModels(withNotes({ read: ['notes.read', 'notes.admin'], insert: 'notes.write', update: 'notes.write' }, {
				columns: { title: { read: 'notes.admin' } },
			})),
			'notes',
		)
		expect(model?.visible).not.toContain('title')
	})

	test("a column's own write action is none of the update actions", () => {
		expect(() =>
			withNotes({ read: 'notes.read', update: ['notes.write', 'notes.admin'] }, { update: [], columns: { title: { write: 'notes.admin' } } })
		)
			.toThrow("notes: columns.title.write names notes.admin, the table's update action; list title in update instead")
	})
})

describe('a queue table', () => {
	const outboxColumns = { columns: ['id', 'recipient', 'attempts', 'due_at', 'version'], foreignKeys: [], timestamps: ['due_at'] }
	const outbox = {
		scope: { app: 'mail goes out through one job' },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.admin' },
		insert: ['recipient', 'due_at'],
		queue: { attempts: 'attempts', due: 'due_at' },
		version: 'version',
	}
	const withOutbox = (policy: unknown, list: object = outboxColumns) =>
		readTables({ ...listOf(columns, keys), outbox: list }, { notes, note_comments: comments, countries, outbox: policy }, vocabulary)

	test('names its attempts and due columns; maxAttempts defaults to 10', () => {
		expect(modelOf(tableModels(withOutbox(outbox)), 'outbox')?.queue).toEqual({ attempts: 'attempts', due: 'due_at', maxAttempts: 10 })
		const capped = { ...outbox, queue: { ...outbox.queue, maxAttempts: 3 } }
		expect(modelOf(tableModels(withOutbox(capped)), 'outbox')?.queue?.maxAttempts).toBe(3)
	})

	test('needs a version column, an update action, and a timestamp due', () => {
		const { version: _, ...unversioned } = outbox
		expect(() => withOutbox(unversioned)).toThrow('outbox: a queue table needs a version column')
		expect(() => withOutbox({ ...outbox, actions: { read: 'notes.read', insert: 'notes.write' } })).toThrow(
			'outbox: a queue table needs an update action',
		)
		expect(() => withOutbox(outbox, { ...outboxColumns, timestamps: [] })).toThrow('outbox: queue.due names due_at, which is not a timestamp column')
	})

	test('the layer writes its columns: attempts is never written by a handler, due only by an insert', () => {
		expect(() => withOutbox({ ...outbox, insert: ['recipient', 'attempts'] })).toThrow('outbox: attempts is stamped by the layer')
		expect(() => withOutbox({ ...outbox, update: ['due_at'] })).toThrow('outbox: due_at is queue.due, which the layer writes')
		expect(() => withOutbox({ ...outbox, queue: { attempts: 'attempts', due: 'attempts' } })).toThrow(
			'outbox: queue.attempts and queue.due name one column, attempts; they need two',
		)
		expect(() => withOutbox({ ...outbox, queue: { ...outbox.queue, maxAttempts: 0 } })).toThrow('outbox: queue.maxAttempts must be a positive integer')
		expect(() => withOutbox({ ...outbox, queue: { ...outbox.queue, retries: 3 } })).toThrow('outbox: queue: retries is not a field here')
	})

	test('a claimed row carries version and ref beside its columns, so the table has no other column of either name', () => {
		const list = { ...outboxColumns, columns: [...outboxColumns.columns, 'ref'] }
		expect(() => withOutbox(outbox, list)).toThrow('outbox: a queue table has no column named ref')
	})

	test('a reference table takes no queue', () => {
		expect(() => define(columns, { notes, note_comments: comments, countries: { ...countries, queue: { attempts: 'code', due: 'name' } } })).toThrow(
			'countries: a reference table is never written by a handler',
		)
	})
})
