// Tables derived from the vocabulary: `defineTables(vocabulary, columns)` takes each table's container from the
// vocabulary's dimensions, its key from the `id` convention, its container column from `<container>_id` (or
// `in: { column }` off it) and a child's column and chain from its parent. The derived models equal the ones a policy
// spells out, from typed and from unchecked values; a derived column the table lacks, or a policy that contradicts
// the vocabulary, is refused. The type half compiles `derived-mistakes/`, where each mistake fails at its own line.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { PolicyError } from '../errors'
import { modelOf, readTables, tableModels } from '../policy'
import { defineTables, tablePolicies } from '../tables'
import { annotated, columns, derived, folders, noteComments, notes, tags, vocabulary, workspaces } from './derived-tables/schema'

const spelledOut = defineTables(vocabulary, columns)({
	workspaces: { scope: { dimension: 'workspace', key: 'id' }, actions: { read: 'notes.read' } },
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', update: 'notes.write' },
		update: ['title'],
		version: 'version',
	},
	note_comments: {
		scope: { child: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id'] },
		actions: { read: 'notes.read', insert: 'notes.write' },
		insert: ['body'],
	},
	folders: { scope: { dimension: 'folder', key: 'id', in: { dimension: 'workspace', column: 'space_id' } }, actions: { read: 'notes.read' } },
	tags: { scope: { dimension: 'tag', key: 'code', in: { dimension: 'workspace', column: 'workspace_id' } }, actions: { read: 'notes.read' } },
	note_links: { scope: { child: 'notes', key: 'id', column: 'parent_note', inherit: ['workspace_id'] }, actions: { read: 'notes.read' } },
})

/** The policies as the static reader has them: plain values, the vocabulary included. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describe('defineTables derives containment from the vocabulary', () => {
	test('the derived policies are the ones the spelled-out form states', () => {
		expect(tablePolicies(defineTables(vocabulary, columns)(derived))).toEqual(tablePolicies(spelledOut))
	})

	test('an annotated policy map takes the same policies', () => {
		expect(tablePolicies(defineTables(vocabulary, columns)(annotated))).toEqual(tablePolicies(spelledOut))
	})

	test('readTables derives the same from unchecked values', () => {
		expect(tablePolicies(readTables(plain(columns), plain(derived), plain(vocabulary)))).toEqual(tablePolicies(spelledOut))
	})

	test('each derivation, as the layer models it', () => {
		const models = tableModels(defineTables(vocabulary, columns)(derived))
		expect(modelOf(models, 'workspaces')?.scope).toEqual({ mode: 'dimension', dimension: 'workspace', key: 'id', container: undefined })
		expect(modelOf(models, 'notes')?.chain).toEqual([{ dimension: 'workspace', column: 'workspace_id' }])
		expect(modelOf(models, 'folders')?.chain).toEqual([{ dimension: 'workspace', column: 'space_id' }])
		expect(modelOf(models, 'tags')?.scope).toMatchObject({ key: 'code' })
		expect(modelOf(models, 'note_comments')?.scope).toEqual({ mode: 'child', parent: 'notes', key: 'id', column: 'note_id', inherit: ['workspace_id'] })
		expect(modelOf(models, 'note_comments')?.chain).toEqual([
			{ dimension: 'note', column: 'note_id' },
			{ dimension: 'workspace', column: 'workspace_id' },
		])
	})
})

describe('a derived column the table lacks, or a policy against the vocabulary, is refused', () => {
	const read = (policies: Readonly<Record<string, unknown>>, dimensions: unknown = vocabulary.dimensions) => () =>
		readTables(plain(columns), plain({ ...derived, ...policies }), plain({ ...vocabulary, dimensions }))

	test('a container column off the convention that the policy does not name', () => {
		expect(read({ folders: { ...folders, scope: { dimension: 'folder' } } })).toThrow(
			new PolicyError(
				'folders: scope.in.column defaults to workspace_id (the vocabulary puts folder in workspace), which is not a column; state scope.in: { column } (columns: id, space_id, name)',
			),
		)
	})

	test('a key the policy does not name, on a table without id', () => {
		expect(read({ tags: { ...tags, scope: { dimension: 'tag' } } })).toThrow(
			'tags: scope.key defaults to id (the key convention), which is not a column; state scope.key (columns: code, workspace_id, label)',
		)
	})

	test("a child's column for its parent that the table does not have", () => {
		const columnsWithoutNoteId = { ...columns, note_comments: { columns: ['id', 'note', 'workspace_id', 'body'], foreignKeys: [] } }
		expect(() => readTables(plain(columnsWithoutNoteId), plain(derived), plain(vocabulary))).toThrow(
			'note_comments: scope.column defaults to note_id (the key of its parent notes), which is not a column; state scope.column (columns: id, note, workspace_id, body)',
		)
	})

	test("a child's stated chain that is not its parent's", () => {
		expect(read({ note_comments: { ...noteComments, scope: { child: 'notes', inherit: [] } } })).toThrow(
			'note_comments: must inherit exactly the containment columns of notes (workspace_id)',
		)
	})

	test('a container column that is not a column', () => {
		expect(read({ folders: { ...folders, scope: { dimension: 'folder', in: { column: 'spaceid' } } } })).toThrow(
			'folders: scope.in.column names spaceid, which is not a column',
		)
	})

	test('a dimension the vocabulary does not declare', () => {
		expect(read({ workspaces: { ...workspaces, scope: { dimension: 'workspce' } } })).toThrow(
			'workspaces: scope.dimension names workspce, which is not a dimension of the vocabulary (dimensions: workspace, note, folder, tag)',
		)
	})

	test('a container the vocabulary contradicts', () => {
		expect(read({ notes: { ...notes, scope: { dimension: 'note', in: { dimension: 'folder', column: 'workspace_id' } } } })).toThrow(
			'notes: the vocabulary puts note in workspace, not in folder',
		)
		expect(read({ workspaces: { ...workspaces, scope: { dimension: 'workspace', in: { column: 'id' } } } })).toThrow(
			'workspaces: the vocabulary puts workspace in no container, so scope.in is not a field here',
		)
	})

	test('a vocabulary whose container is not one of its dimensions', () => {
		expect(read({}, { ...vocabulary.dimensions, note: { in: 'space' } })).toThrow(
			'the vocabulary puts note in space, which is not one of its dimensions',
		)
	})

	test('the form that names the action union by hand: one argument, the column list', () => {
		expect(() => Reflect.apply(defineTables, undefined, [columns])).toThrow(
			new PolicyError('defineTables takes the vocabulary and the generated column list: defineTables(vocabulary, columns)({ … })'),
		)
	})
})

describe('a containment column is a foreign key to the key of the table that owns the container', () => {
	const withColumns = (table: string, entry: unknown) => plain({ ...columns, [table]: entry })

	test('a conventional column that exists but is not the foreign key is refused, naming the one that is', () => {
		const folderColumns = {
			columns: ['id', 'workspace_id', 'space_id', 'name'],
			foreignKeys: [{ columns: ['space_id'], table: 'workspaces', references: ['id'] }],
		}
		const policies = plain({ ...derived, folders: { ...folders, scope: { dimension: 'folder' } } })
		expect(() => readTables(withColumns('folders', folderColumns), policies, plain(vocabulary))).toThrow(
			new PolicyError("folders: workspace_id is not a foreign key to workspaces.id, which owns workspace; state scope.in: { column: 'space_id' }"),
		)
		const stated = plain({ ...derived, folders: { ...folders, scope: { dimension: 'folder', in: { column: 'workspace_id' } } } })
		expect(() => readTables(withColumns('folders', folderColumns), stated, plain(vocabulary))).toThrow(
			"folders: workspace_id is not a foreign key to workspaces.id, which owns workspace; state scope.in: { column: 'space_id' }",
		)
	})

	test("a child's conventional column that is not its foreign key to the parent is refused", () => {
		const commentColumns = {
			columns: ['id', 'note_id', 'parent_note', 'workspace_id', 'body'],
			foreignKeys: [{ columns: ['parent_note', 'workspace_id'], table: 'notes', references: ['id', 'workspace_id'] }],
		}
		expect(() => readTables(withColumns('note_comments', commentColumns), plain(derived), plain(vocabulary))).toThrow(
			"note_comments: note_id is not a foreign key to notes.id, which owns note; state scope.column: 'parent_note'",
		)
	})

	test('a container column without any foreign key is refused, naming the migration to write', () => {
		const tagColumns = { columns: ['code', 'workspace_id', 'label'], foreignKeys: [] }
		expect(() => readTables(withColumns('tags', tagColumns), plain(derived), plain(vocabulary))).toThrow(
			'tags: workspace_id is not a foreign key to workspaces.id, which owns workspace; add a foreign key from workspace_id to workspaces (id) in a migration',
		)
	})

	test('a container no table owns has no key to reference: the convention stands', () => {
		const onlyNotes = { notes: { columns: ['id', 'workspace_id', 'title', 'version'], foreignKeys: [] } }
		const models = tableModels(readTables(onlyNotes, plain({ notes }), plain(vocabulary)))
		expect(modelOf(models, 'notes')?.chain).toEqual([{ dimension: 'workspace', column: 'workspace_id' }])
	})
})

describe('a dimension no table owns keeps the vocabulary ancestry above it', () => {
	const ancestry = {
		dimensions: { org: {}, project: { in: 'org' }, task: { in: 'project' } },
		actions: { 'tasks.read': 'Read', 'tasks.write': 'Write' },
	}
	const tasks = { scope: { dimension: 'task' }, actions: { read: 'tasks.read', update: 'tasks.write' }, update: ['title'] }
	const taskColumns = (names: readonly string[]) => ({ tasks: { columns: names, foreignKeys: [] } })

	test('the chain runs through the unowned project to the org', () => {
		const models = tableModels(readTables(taskColumns(['id', 'project_id', 'org_id', 'title']), { tasks }, ancestry))
		expect(modelOf(models, 'tasks')?.chain).toEqual([
			{ dimension: 'project', column: 'project_id' },
			{ dimension: 'org', column: 'org_id' },
		])
	})

	test('the ancestor column is stamped, and a table without it is refused', () => {
		expect(() => readTables(taskColumns(['id', 'project_id', 'org_id', 'title']), { tasks: { ...tasks, update: ['org_id'] } }, ancestry))
			.toThrow('tasks: org_id is stamped by the layer; remove it from insert and update')
		expect(() => readTables(taskColumns(['id', 'project_id', 'title']), { tasks }, ancestry)).toThrow(
			'tasks: must carry org_id, because it lies in org; a row carries its whole containment chain',
		)
	})
})

describe('every action is one of the vocabulary', () => {
	const read = (policies: Readonly<Record<string, unknown>>) => () => readTables(plain(columns), plain({ ...derived, ...policies }), plain(vocabulary))

	test('a table action and a column read outside the vocabulary are refused', () => {
		expect(read({ workspaces: { ...workspaces, actions: { read: 'notes.raed' } } })).toThrow(
			new PolicyError('workspaces: actions.read names notes.raed, which is not an action of the vocabulary (actions: notes.read, notes.write)'),
		)
		expect(read({ notes: { ...notes, columns: { title: { read: 'notes.raed' } } } })).toThrow(
			'notes: columns.title.read names notes.raed, which is not an action of the vocabulary',
		)
	})
})

/** Each mistake, by its file under `derived-mistakes/`: the diagnostic on the line after its `// mistake:` marker. */
const MISTAKES: Readonly<Record<string, string>> = {
	// The compiler lists a union's members in no fixed order, so a union is held to its head.
	'01-action-typo.ts': `Type '"notes.raed"' is not assignable to type 'TableAction<"notes.read" | "notes.write">'. Did you mean '"notes.read"'?`,
	'02-dimension-typo.ts': `Type '"workspce"' is not assignable to type '"workspace" | "note" | "folder" | "tag"'. Did you mean '"workspace"'?`,
	'03-child-parent-typo.ts': `Type '"nots"' is not assignable to type`,
	'04-container-column-typo.ts': `Type '"spaceid"' is not assignable to type`,
	'05-off-convention-without-in.ts': `Property 'in' is missing in type '{ dimension: "folder"; }' but required in type 'NamesItsContainerColumn<`,
	'06-key-without-id.ts': `Property 'key' is missing in type '{ dimension: "tag"; }' but required in type 'NamesItsKey<`,
	'07-action-union-by-hand.ts': 'Expected 2 arguments, but got 1',
	'08-child-of-a-child.ts': `Type '"note_comments"' is not assignable to type`,
	'09-child-off-convention-without-column.ts':
		`Property 'column' is missing in type '{ child: "notes"; }' but required in type 'NamesItsParentColumn<`,
	'10-annotated-map-without-in.ts': "Property 'in' is missing",
}

/** An annotated map is checked against every dimension's scope, which the compiler elaborates past two lines. */
const ELABORATED = ['10-annotated-map-without-in.ts']

describe('a typo in a derived policy fails tsc at its line', () => {
	const directory = join(import.meta.dir, 'derived-mistakes')
	const files = readdirSync(directory).filter((file) => file.endsWith('.ts')).sort()
	const packageDir = join(import.meta.dir, '..', '..')
	const config = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile)
	const options = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir).options
	const program = ts.createProgram(files.map((file) => join(directory, file)), { ...options, noEmit: true })
	const diagnostics = (file: string): readonly string[] => {
		const source = program.getSourceFile(join(directory, file))
		if (source === undefined) {
			throw new Error(`${file} did not load`)
		}
		return ts.getPreEmitDiagnostics(program, source).map((diagnostic) => {
			const line = diagnostic.start === undefined ? 0 : source.getLineAndCharacterOfPosition(diagnostic.start).line + 1
			return `${line} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
		})
	}
	const markedLine = (file: string): number =>
		readFileSync(join(directory, file), 'utf8').split('\n').findIndex((line) => line.trim().startsWith('// mistake:')) + 2

	test('every mistake file has an expectation', () => {
		expect(files).toEqual(Object.keys(MISTAKES))
	})

	for (const [file, expected] of Object.entries(MISTAKES)) {
		test(file, () => {
			const found = diagnostics(file)
			const line = markedLine(file)
			expect(line).toBeGreaterThan(1)
			expect(found.length).toBeGreaterThan(0)
			expect(found.filter((diagnostic) => !diagnostic.startsWith(`${line} `))).toEqual([])
			expect(found.join('\n')).toContain(expected)
			for (const diagnostic of ELABORATED.includes(file) ? [] : found) {
				expect(diagnostic.split('\n').length).toBeLessThanOrEqual(2)
			}
		})
	}
})
