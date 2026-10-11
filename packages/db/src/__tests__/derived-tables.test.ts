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
import { columns, derived, folders, noteComments, notes, tags, vocabulary, workspaces } from './derived-tables/schema'

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
})

/** The policies as the static reader has them: plain values, the vocabulary included. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describe('defineTables derives containment from the vocabulary', () => {
	test('the derived policies are the ones the spelled-out form states', () => {
		expect(tablePolicies(defineTables(vocabulary, columns)(derived))).toEqual(tablePolicies(spelledOut))
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
		const columnsWithoutNoteId = { ...columns, note_comments: ['id', 'note', 'workspace_id', 'body'] }
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

/** Each mistake, by its file under `derived-mistakes/`: the diagnostic on the line after its `// mistake:` marker. */
const MISTAKES: Readonly<Record<string, string>> = {
	// The compiler lists a union's members in no fixed order, so a union is held to its head.
	'01-action-typo.ts': `Type '"notes.raed"' is not assignable to type '"notes.read" | "notes.write"'`,
	'02-dimension-typo.ts': `Type '"workspce"' is not assignable to type '"workspace" | "note" | "folder" | "tag"'. Did you mean '"workspace"'?`,
	'03-child-parent-typo.ts': `Type '"nots"' is not assignable to type`,
	'04-container-column-typo.ts': `Type '"spaceid"' is not assignable to type`,
	'05-off-convention-without-in.ts': `Property 'in' is missing in type '{ dimension: "folder"; }' but required in type 'NamesItsContainerColumn<`,
	'06-key-without-id.ts': `Property 'key' is missing in type '{ dimension: "tag"; }' but required in type 'NamesItsKey<`,
	'07-action-union-by-hand.ts': 'Expected 2 arguments, but got 1',
}

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
			for (const diagnostic of found) {
				expect(diagnostic.split('\n').length).toBeLessThanOrEqual(2)
			}
		})
	}
})
