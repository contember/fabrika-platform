// `fabrika db codegen`'s rendering, and its introspection against a REAL Postgres (skips cleanly without
// FABRIKA_TEST_POSTGRES_URL). The fixture `schema.generated.ts` that the rest of this package's tests use is this
// codegen's output for the fixture migration, and the Postgres suite regenerates it byte for byte.

import { checkApplication, formatFinding } from '@fabrika/check'
import { classifyMigrations } from '@fabrika/platform-node/sql'
import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { z } from 'zod/v4'
import { type CatalogColumn, CodegenError, generateSchema, introspectSchema, renderSchema } from '../codegen'
import { migration } from './fixtures/schema'
import { migration as tasksMigration } from './fixtures/tasks'

const column = (table: string, name: string, type: string, extra: Partial<CatalogColumn> = {}): CatalogColumn => ({
	table_name: table,
	view: false,
	column_name: name,
	type_name: type,
	type_type: 'b',
	type_category: 'S',
	nullable: false,
	generated: 'no',
	computed: false,
	formatted_type: type,
	keyed: false,
	enum_labels: [],
	...extra,
})

const interfaceOf = (source: string, name: string): string => {
	const start = source.indexOf(`export interface ${name} {`)
	return source.slice(start, source.indexOf('}\n', start) + 2)
}

describe('renderSchema', () => {
	test('maps each column to what Bun.SQL decodes and what the layer may bind', () => {
		const { source } = renderSchema([
			column('things', 'id', 'uuid'),
			column('things', 'small', 'int2'),
			column('things', 'big', 'int8'),
			column('things', 'amount', 'numeric', { nullable: true }),
			column('things', 'ratio', 'float8'),
			column('things', 'done', 'bool'),
			column('things', 'due', 'date', { nullable: true }),
			column('things', 'created_at', 'timestamptz', { generated: 'default' }),
			column('things', 'serial', 'int8', { generated: 'default' }),
			column('things', 'total', 'int4', { generated: 'always' }),
			column('things', 'state', 'thing_state', { type_type: 'e', type_category: 'E', enum_labels: ['draft', "it's"] }),
		])
		expect(interfaceOf(source, 'ThingsTable')).toBe(`export interface ThingsTable {
	id: string
	small: number
	big: ColumnType<string, bigint | number | string, bigint | number | string>
	amount: ColumnType<string | null, bigint | number | string | null, bigint | number | string | null>
	ratio: number
	done: boolean
	due: string | null
	created_at: ColumnType<Date, Date | string | undefined, Date | string>
	serial: ColumnType<string, bigint | number | string | undefined, bigint | number | string>
	total: GeneratedAlways<number>
	state: 'draft' | 'it\\'s'
}
`)
		expect(source).toContain("import type { ColumnType, GeneratedAlways } from 'kysely'\n")
		expect(source).toContain("\t\tforeignKeys: [],\n\t\tdates: ['due'],\n\t\ttimestamps: ['created_at'],\n\t},\n")
	})

	test('leaves out framework tables and imports only what it uses', () => {
		const { source } = renderSchema([column('fabrika_migrations', 'name', 'text'), column('notes', 'id', 'text')])
		expect(source).not.toContain('fabrika_migrations')
		expect(source).not.toContain("from 'kysely'")
		expect(source).toContain('export interface DB {\n\tnotes: NotesTable\n}\n')
		expect(source).toContain(
			"export const columns: TypedColumnList<DB> = {\n\t'notes': {\n\t\tcolumns: [\n\t\t\t'id',\n\t\t],\n\t\tforeignKeys: [],\n\t},\n}\n",
		)
	})

	test("writes each table's foreign keys to application tables, a composite one in key order", () => {
		const foreignKey = (table: string, name: string, columns: string[], referenced: string, references: string[]) => ({
			table_name: table,
			constraint_name: name,
			columns,
			referenced_table: referenced,
			referenced_columns: references,
		})
		const { source } = renderSchema(
			[
				column('workspaces', 'id', 'text'),
				column('workspaces', 'org_id', 'text'),
				column('notes', 'id', 'text'),
				column('notes', 'workspace_id', 'text'),
				column('notes', 'org_id', 'text'),
			],
			[
				foreignKey('notes', 'notes_workspace_fkey', ['workspace_id', 'org_id'], 'workspaces', ['id', 'org_id']),
				foreignKey('notes', 'notes_ledger_fkey', ['id'], 'fabrika_migrations', ['name']),
			],
		)
		expect(source).toContain(`	'notes': {
		columns: [
			'id',
			'workspace_id',
			'org_id',
		],
		foreignKeys: [
			{
				columns: ['workspace_id', 'org_id'],
				table: 'workspaces',
				references: ['id', 'org_id'],
			},
		],
	},
`)
		expect(source).not.toContain('fabrika_migrations')
	})

	test('orders tables by name and keeps column order', () => {
		const { source } = renderSchema([column('notes', 'title', 'text'), column('notes', 'id', 'text'), column('authors', 'id', 'text')])
		expect(source.indexOf('AuthorsTable {')).toBeLessThan(source.indexOf('NotesTable {'))
		expect(interfaceOf(source, 'NotesTable')).toBe('export interface NotesTable {\n\ttitle: string\n\tid: string\n}\n')
	})

	test('types a jsonb column as unknown on read and a JSON value on write, and lists it as json', () => {
		const { source } = renderSchema([
			column('links', 'id', 'uuid'),
			column('links', 'metadata', 'jsonb'),
			column('links', 'extra', 'jsonb', { nullable: true }),
			column('links', 'tags', 'jsonb', { generated: 'default' }),
		])
		expect(source).toContain("import type { JsonColumnValue, TypedColumnList } from '@fabrika/db'\n")
		expect(interfaceOf(source, 'LinksTable')).toBe(`export interface LinksTable {
	id: string
	metadata: ColumnType<unknown, JsonColumnValue, JsonColumnValue>
	extra: ColumnType<unknown | null, JsonColumnValue | null, JsonColumnValue | null>
	tags: ColumnType<unknown, JsonColumnValue | undefined, JsonColumnValue>
}
`)
		expect(source).toContain("\t\tforeignKeys: [],\n\t\tjson: ['metadata', 'extra', 'tags'],\n\t},\n")
		expect(renderSchema([column('notes', 'id', 'text')]).source).toContain("import type { TypedColumnList } from '@fabrika/db'\n")
	})

	test('refuses a json column and names jsonb', () => {
		expect(() => renderSchema([column('notes', 'meta', 'json')])).toThrow(
			'notes.meta has type json; declare it jsonb, which the data layer reads and binds (json keeps whitespace and duplicate keys)',
		)
		expect(() => renderSchema([column('notes', 'metas', '_json', { type_category: 'A' })])).toThrow('notes.metas has type _json, which the data layer')
	})

	test('refuses a type it cannot type exactly, rather than guessing', () => {
		for (
			const unsupported of [
				column('notes', 'metas', '_jsonb', { type_category: 'A' }),
				column('notes', 'blob', 'bytea'),
				column('notes', 'tags', '_text', { type_category: 'A' }),
				column('notes', 'email', 'email_address', { type_type: 'd' }),
			]
		) {
			expect(() => renderSchema([unsupported])).toThrow(CodegenError)
		}
		expect(() => renderSchema([column('notes', 'blob', 'bytea')])).toThrow(
			'notes.blob has type bytea, which the data layer does not read or bind (supported: text,',
		)
	})

	test('leaves out a generated column of a type it does not read, naming it; any other column of one is refused', () => {
		const search = column('documents', 'search', 'tsvector', { generated: 'always', computed: true })
		const module = renderSchema([column('documents', 'id', 'text'), search, column('documents', 'body', 'text')])
		expect(module.leftOut).toEqual([{ table: 'documents', column: 'search', type: 'tsvector', of: 'generated' }])
		expect(interfaceOf(module.source, 'DocumentsTable')).toBe(
			'export interface DocumentsTable {\n\tid: string\n\t// search (tsvector, generated) is left out: the data layer does not read it; ctx.sql does\n\tbody: string\n}\n',
		)
		expect(module.source).not.toContain("'search'")
		// Every type the layer does not read is left out of a generated column: an array, `json`, a range, a composite, a domain.
		const computed = { generated: 'always', computed: true } as const
		const others = renderSchema([
			column('documents', 'id', 'text'),
			column('documents', 'raw', 'json', computed),
			column('documents', 'tags', '_text', { ...computed, type_category: 'A', formatted_type: 'text[]' }),
			column('documents', 'span', 'int4range', { ...computed, type_type: 'r' }),
			column('documents', 'pair', 'point_pair', { ...computed, type_type: 'c' }),
			column('documents', 'mail', 'email', { ...computed, type_type: 'd' }),
			column('documents', 'odd', 'odd', { ...computed, type_type: 'c', formatted_type: 'odd\ntype' }),
		])
		expect(others.leftOut.map((left) => left.type)).toEqual(['json', 'text[]', 'int4range', 'point_pair', 'email', 'odd\ntype'])
		// The comment quotes a type name that could end its line; the list keeps the name as written.
		expect(others.source).toContain("\t// odd ('odd\\ntype', generated) is left out: the data layer does not read it; ctx.sql does\n")
		// A plain column, a defaulted one, and one `always` without being computed (an identity column) are refused.
		for (const extra of [{}, { generated: 'default' }, { generated: 'always' }] as const) {
			expect(() => renderSchema([column('documents', 'search', 'tsvector', extra)])).toThrow(
				'documents.search has type tsvector, which the data layer does not read or bind',
			)
		}
	})

	test('refuses a left-out column in a key or a foreign key, and a table it would leave with no column', () => {
		const leftOut = (table: string) => column(table, 'search', 'tsvector', { generated: 'always', computed: true })
		expect(() =>
			renderSchema([column('documents', 'id', 'text'), column('documents', 'search', 'tsvector', { generated: 'always', computed: true, keyed: true })])
		)
			.toThrow(
				'documents.search is a generated column of a type the data layer does not read, so codegen leaves it out, but it is in the primary key or a unique key',
			)
		const key = { constraint_name: 'k', table_name: 'links', columns: ['search'], referenced_table: 'documents', referenced_columns: ['search'] }
		expect(() => renderSchema([column('documents', 'id', 'text'), leftOut('documents'), column('links', 'id', 'text'), leftOut('links')], [key]))
			.toThrow(
				'links.search is a generated column of a type the data layer does not read, so codegen leaves it out, but a foreign key of links names it',
			)
		expect(() => renderSchema([leftOut('documents')])).toThrow(
			'table documents has only generated columns of types the data layer does not read, which codegen leaves out',
		)
	})

	test('refuses names the data layer cannot address and names that collide', () => {
		expect(() => renderSchema([column('Notes', 'id', 'text')])).toThrow('Notes is not a plain identifier')
		expect(() => renderSchema([column('notes', 'Title', 'text')])).toThrow('Title is not a plain identifier')
		expect(() => renderSchema([column('a_b', 'id', 'text'), column('a__b', 'id', 'text')])).toThrow(
			'tables a__b and a_b would both generate ABTable',
		)
	})
})

/** Type-checks `source` as if it were a module of this package, with the package's compiler options. */
function typeErrors(source: string): string[] {
	const packageDir = join(import.meta.dir, '..', '..')
	const config = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile)
	const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir).options, noEmit: true }
	const file = join(import.meta.dir, 'generated-under-test.ts')
	const host = ts.createCompilerHost(options)
	const getSourceFile = host.getSourceFile.bind(host)
	host.getSourceFile = (name, version, ...rest) => name === file ? ts.createSourceFile(name, source, version) : getSourceFile(name, version, ...rest)
	const fileExists = host.fileExists.bind(host)
	host.fileExists = (name) => name === file || fileExists(name)
	const program = ts.createProgram([file], options, host)
	return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map((diagnostic) =>
		ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
	)
}

describe('generated names', () => {
	const catalog = [column('_123', 'id', 'text'), column('_9_lives', 'id', 'text'), column('notes', 'id', 'text')]

	test('a table name that does not start with a letter still gives a TypeScript identifier', () => {
		const { source } = renderSchema(catalog)
		expect(source).toContain('export interface T123Table {')
		expect(source).toContain('export interface T9LivesTable {')
		expect(typeErrors(source)).toEqual([])
		expect(typeErrors('export interface 123Table {}\n')).not.toEqual([])
	})

	test('a prefixed name that collides with another table is refused', () => {
		expect(() => renderSchema([column('_123', 'id', 'text'), column('t123', 'id', 'text')])).toThrow(
			'tables _123 and t123 would both generate T123Table',
		)
	})

	test('a reserved JavaScript name is refused', () => {
		for (const table of ['__proto__', 'constructor', 'prototype']) {
			expect(() => renderSchema([column(table, 'id', 'text')])).toThrow(`table ${table} has a reserved JavaScript name`)
		}
	})

	test('the evaluated column map has every table as an own entry', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'fabrika-codegen-'))
		try {
			const module = join(directory, 'schema.generated.js')
			writeFileSync(module, new Bun.Transpiler({ loader: 'ts' }).transformSync(renderSchema(catalog).source))
			const loaded: unknown = await import(module)
			const columns: unknown = typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, 'columns') : undefined
			expect(typeof columns === 'object' && columns !== null ? Object.keys(columns) : []).toEqual(['_123', '_9_lives', 'notes'])
			expect(Object.getPrototypeOf(columns)).toBe(Object.prototype)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

describe('the generated module under the checker', () => {
	const fixture = Bun.file(join(import.meta.dir, 'fixtures', 'schema.generated.ts')).text()
	const vocabulary = `import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({ app: 'lookup', dimensions: {}, actions: { 'countries.read': 'Read the lookup data' }, roles: {} })
`
	const tables = `import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	countries: { scope: { reference: 'lookup data' }, actions: { read: 'countries.read' } },
	note_comments: { scope: { reference: 'lookup data' }, actions: { read: 'countries.read' } },
	note_flags: { scope: { reference: 'lookup data' }, actions: { read: 'countries.read' } },
	notes: { scope: { reference: 'lookup data' }, actions: { read: 'countries.read' } },
	organizations: { scope: { reference: 'lookup data' }, actions: { read: 'countries.read' } },
	secrets: { scope: { reference: 'lookup data' }, actions: { read: 'countries.read' } },
	settings: { scope: { reference: 'lookup data' }, actions: { read: 'countries.read' } },
	workspaces: { scope: { reference: 'lookup data' }, actions: { read: 'countries.read' } },
})
`
	const check = async (generated: string): Promise<string[]> =>
		(await checkApplication({
			root: '/app',
			files: new Map([['src/db/schema.generated.ts', generated], ['src/db/tables.ts', tables], ['src/vocabulary.ts', vocabulary]]),
		})).map(
			formatFinding,
		)

	test('has no finding, as a literal module of tables.ts', async () => {
		expect(await check(await fixture)).toEqual([])
	})

	test('is inside the literal graph, so an edit to it is a finding', async () => {
		expect((await check(`${await fixture}export const extra = Date.now()\n`)).some((line) => line.includes(' literal '))).toBe(true)
	})
})

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) console.warn(`codegen.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)

const schemas: string[] = []

afterAll(async () => {
	if (!hasPostgres) return
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	for (const schema of schemas) await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
	await sql.close()
})

/** A fresh schema with `ddl` applied, as `fabrika db migrate` leaves it (ledger included). */
async function migrated(ddl: string): Promise<string> {
	const schema = `codegen_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
	schemas.push(schema)
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		await sql.unsafe(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};
			CREATE TABLE fabrika_migrations (bundle TEXT NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);
			${ddl}`)
	} finally {
		await sql.close()
	}
	return schema
}

describe.skipIf(!hasPostgres)('codegen against real Postgres', () => {
	test('regenerates the committed fixture from the fixture migration', async () => {
		const schema = await migrated(migration)
		expect((await generateSchema(url, schema, [])).source).toBe(await Bun.file(join(import.meta.dir, 'fixtures', 'schema.generated.ts')).text())
	})

	test('regenerates the task tracker fixture: a date column is listed as a day, a timestamp takes ISO text', async () => {
		const schema = await migrated(tasksMigration)
		expect((await generateSchema(url, schema, [])).source).toBe(await Bun.file(join(import.meta.dir, 'fixtures', 'tasks.generated.ts')).text())
	})

	test('types each supported column as Bun.SQL decodes it', async () => {
		const schema = await migrated(`
			CREATE TYPE mood AS ENUM ('calm', 'busy');
			CREATE TABLE samples (
				id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				label varchar(20) NOT NULL,
				code char(2) NOT NULL,
				small int2 NOT NULL,
				medium int4 NOT NULL,
				big int8 NOT NULL,
				amount numeric NOT NULL,
				ratio float4 NOT NULL,
				share float8 NOT NULL,
				done bool NOT NULL,
				due date NOT NULL,
				seen timestamp NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now(),
				starts time NOT NULL,
				starts_tz timetz NOT NULL,
				length interval NOT NULL,
				state mood NOT NULL,
				counter int8 GENERATED ALWAYS AS IDENTITY,
				twice int4 GENERATED ALWAYS AS (medium * 2) STORED,
				note text,
				meta jsonb NOT NULL,
				extra jsonb
			);
			INSERT INTO samples (label, code, small, medium, big, amount, ratio, share, done, due, seen, starts, starts_tz, length, state, meta)
			VALUES ('a', 'xy', 1, 2, 3, 4.5, 1.5, 2.5, true, '2026-10-08', '2026-10-08 12:00', '12:00', '12:00+02', '1 hour', 'busy', '{"a": [1, "x", null]}');
		`)
		const { source } = await generateSchema(url, schema, [])
		expect(interfaceOf(source, 'SamplesTable')).toBe(`export interface SamplesTable {
	id: Generated<string>
	label: string
	code: string
	small: number
	medium: number
	big: ColumnType<string, bigint | number | string, bigint | number | string>
	amount: ColumnType<string, bigint | number | string, bigint | number | string>
	ratio: number
	share: number
	done: boolean
	due: string
	seen: ColumnType<Date, Date | string, Date | string>
	created_at: ColumnType<Date, Date | string | undefined, Date | string>
	starts: string
	starts_tz: string
	length: string
	state: 'calm' | 'busy'
	counter: GeneratedAlways<string>
	twice: GeneratedAlways<number | null>
	note: string | null
	meta: ColumnType<unknown, JsonColumnValue, JsonColumnValue>
	extra: ColumnType<unknown | null, JsonColumnValue | null, JsonColumnValue | null>
}
`)

		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		let row: unknown
		try {
			const rows: unknown = await sql.unsafe(`SELECT * FROM ${schema}.samples`)
			row = Array.isArray(rows) ? rows[0] : undefined
		} finally {
			await sql.close()
		}
		const decoded = typeof row === 'object' && row !== null ? Object.entries(row) : []
		const kind = (value: unknown): string => (value instanceof Date ? 'Date' : value === null ? 'null' : typeof value)
		expect(Object.fromEntries(decoded.map(([key, value]) => [key, kind(value)]))).toEqual({
			id: 'string',
			label: 'string',
			code: 'string',
			small: 'number',
			medium: 'number',
			big: 'string',
			amount: 'string',
			ratio: 'number',
			share: 'number',
			done: 'boolean',
			due: 'Date',
			seen: 'Date',
			created_at: 'Date',
			starts: 'string',
			starts_tz: 'string',
			length: 'string',
			state: 'string',
			counter: 'string',
			twice: 'number',
			note: 'null',
			meta: 'object',
			extra: 'null',
		})
		expect(typeof row === 'object' && row !== null ? Reflect.get(row, 'meta') : undefined).toEqual({ a: [1, 'x', null] })
	})

	test("pins Bun.SQL's jsonb binding, unprepared as the layer runs it: JSON text binds as its value, an object is refused", async () => {
		const schema = await migrated('CREATE TABLE docs (id int4 PRIMARY KEY, body jsonb NOT NULL);')
		const sql = new SQL({ url, adapter: 'postgres', max: 1, prepare: false })
		try {
			const texts = ['{"a": {"b": [1, 2.5, true, null]}}', '"text"', '7', '[]', 'null']
			for (const [index, text] of texts.entries()) {
				await sql.unsafe(`INSERT INTO ${schema}.docs (id, body) VALUES ($1, $2)`, [index, text])
			}
			await sql.unsafe(`UPDATE ${schema}.docs SET body = $1 WHERE id = 3`, ['["updated"]'])
			const rows = z.array(z.object({ id: z.number(), body: z.unknown(), kind: z.string() })).parse(
				await sql.unsafe(`SELECT id, body, jsonb_typeof(body) AS kind FROM ${schema}.docs ORDER BY id`),
			)
			expect(rows).toEqual([
				{ id: 0, body: { a: { b: [1, 2.5, true, null] } }, kind: 'object' },
				{ id: 1, body: 'text', kind: 'string' },
				{ id: 2, body: 7, kind: 'number' },
				{ id: 3, body: ['updated'], kind: 'array' },
				// A top-level JSON null decodes as null, as SQL NULL does.
				{ id: 4, body: null, kind: 'null' },
			])
			// Settled into a plain promise first: `expect(...).rejects` spins on Bun.SQL's lazy query.
			const refused = await sql.unsafe(`INSERT INTO ${schema}.docs (id, body) VALUES (9, $1)`, [{ a: 1 }]).then(
				() => undefined,
				(error: unknown) => error,
			)
			expect(String(refused)).toContain('invalid input syntax for type json')
		} finally {
			await sql.close()
		}
	})

	test('leaves out a stored generated tsvector under a GIN index, by attgenerated; a plain one is refused', async () => {
		const ddl = `CREATE TABLE documents (
			id text PRIMARY KEY,
			n int8 GENERATED ALWAYS AS IDENTITY,
			body text,
			search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED,
			words text[] GENERATED ALWAYS AS (ARRAY[body]) STORED
		);
		CREATE INDEX documents_search ON documents USING gin (search);`
		const schema = await migrated(ddl)
		const read = (await introspectSchema(url, schema, [])).filter((column) => column.table_name === 'documents').map((column) => [
			column.column_name,
			column.generated,
			column.computed,
			column.keyed,
		])
		expect(read).toEqual([
			['id', 'no', false, true],
			['n', 'always', false, false],
			['body', 'no', false, false],
			['search', 'always', true, false],
			['words', 'always', true, false],
		])
		const module = await generateSchema(url, schema, [])
		expect(module.leftOut).toEqual([
			{ table: 'documents', column: 'search', type: 'tsvector', of: 'generated' },
			{ table: 'documents', column: 'words', type: 'text[]', of: 'generated' },
		])
		expect(interfaceOf(module.source, 'DocumentsTable')).toBe(
			'export interface DocumentsTable {\n\tid: string\n\tn: GeneratedAlways<string>\n\tbody: string | null\n'
				+ '\t// search (tsvector, generated) is left out: the data layer does not read it; ctx.sql does\n'
				+ '\t// words (text[], generated) is left out: the data layer does not read it; ctx.sql does\n}\n',
		)
		expect(module.source).not.toContain("'search'")
		await expect(generateSchema(url, await migrated('CREATE TABLE documents (id text PRIMARY KEY, search tsvector);'), [])).rejects.toThrow(
			'documents.search has type tsvector, which the data layer does not read or bind',
		)
		const keyed = await migrated(
			`CREATE TABLE documents (id text PRIMARY KEY, body text, words text[] GENERATED ALWAYS AS (ARRAY[body]) STORED);
			CREATE UNIQUE INDEX documents_words ON documents (words);`,
		)
		await expect(generateSchema(url, keyed, [])).rejects.toThrow(
			'documents.words is a generated column of a type the data layer does not read, so codegen leaves it out, but it is in the primary key or a unique key',
		)
	})

	test('reads a view as nullable columns marked view, leaving out a column of a type it does not read, and a materialized view whole', async () => {
		const ddl = `
			CREATE TABLE deals (id uuid PRIMARY KEY, org_id uuid NOT NULL, title text NOT NULL, opened_at timestamptz NOT NULL);
			CREATE TABLE activities (id uuid PRIMARY KEY, deal_id uuid NOT NULL REFERENCES deals, at timestamptz NOT NULL);
			CREATE VIEW deal_summaries AS
				SELECT d.id AS deal_id, d.org_id, d.title, count(a.id) AS activities, count(a.id)::int4 AS n, max(a.at) AS last_at,
					array_agg(a.id) AS ids
				FROM deals d LEFT JOIN activities a ON a.deal_id = d.id GROUP BY d.id;
			CREATE VIEW deal_days AS SELECT d.id AS deal_id, d.org_id, d.opened_at::date AS opened_on FROM deals d;
			CREATE MATERIALIZED VIEW deal_titles AS SELECT d.id AS deal_id, d.org_id, d.title FROM deals d;
			CREATE VIEW only_arrays AS SELECT array_agg(id) AS ids FROM deals;
		`
		const schema = await migrated(ddl)
		const { objects } = classifyMigrations([{ name: '20261008120000_init.sql', sql: ddl }], schema)
		const module = await generateSchema(url, schema, objects)
		expect(interfaceOf(module.source, 'DealSummariesView')).toBe(
			[
				'export interface DealSummariesView {',
				'\tdeal_id: string | null',
				'\torg_id: string | null',
				'\ttitle: string | null',
				'\tactivities: ColumnType<string | null, bigint | number | string | null, bigint | number | string | null>',
				'\tn: number | null',
				'\tlast_at: ColumnType<Date | null, Date | string | null, Date | string | null>',
				'\t// ids (uuid[], of a view) is left out: the data layer does not read it; cast it to a type it reads, or read it with ctx.sql',
				'}',
				'',
			].join('\n'),
		)
		expect(interfaceOf(module.source, 'DealDaysView')).toContain('\topened_on: string | null\n')
		expect(module.leftOut).toEqual([
			{ table: 'deal_summaries', column: 'ids', type: 'uuid[]', of: 'view' },
			{ table: 'only_arrays', column: 'ids', type: 'uuid[]', of: 'view' },
		])
		expect(module.source).not.toContain('OnlyArraysView')
		expect(module.source).not.toContain('deal_titles')
		expect(module.source).toContain(
			"export type Views =\n\t| 'deal_days'\n\t| 'deal_summaries'\n\nexport const columns: TypedColumnList<DB, Views> = {",
		)
		expect(module.source).toContain("\t'deal_summaries': {\n\t\tcolumns: [\n\t\t\t'deal_id',")
		expect(module.source).toContain("\t\tforeignKeys: [],\n\t\tdates: ['opened_on'],\n\t\tview: true,\n\t},\n\t'deal_summaries': {")
	})

	test('refuses database code no migration declares, and admits what the manifest names', async () => {
		const ddl = `
			CREATE TABLE deals (id text PRIMARY KEY, stage text NOT NULL, n bigint GENERATED ALWAYS AS IDENTITY, at timestamptz DEFAULT now(), label text DEFAULT 'x');
			CREATE FUNCTION spread() RETURNS trigger LANGUAGE plpgsql AS $body$
			BEGIN UPDATE deals SET stage = NEW.stage WHERE id <> NEW.id; RETURN NEW; END
			$body$;
			CREATE TRIGGER spread AFTER UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION spread();
			CREATE RULE mirror AS ON DELETE TO deals DO ALSO DELETE FROM deals;
			CREATE VIEW open_deals AS SELECT id FROM deals;
			CREATE POLICY own ON deals USING (true);
		`
		const schema = await migrated(ddl)
		const undeclared = ['function spread', 'policy deals.own', 'rule deals.mirror', 'trigger deals.spread', 'view open_deals']
		const refusal = `schema ${schema} holds database code that escapes it or that no migration declares: ${
			undeclared.map((object) => `${object} (no migration declares it)`).join(', ')
		}; declare it in a migration or drop it in a new one`
		await expect(introspectSchema(url, schema, [])).rejects.toThrow(refusal)
		await expect(generateSchema(url, schema, [])).rejects.toThrow(CodegenError)
		const { files, objects } = classifyMigrations([{ name: '20261008120000_init.sql', sql: ddl }], schema)
		expect(files[0]?.refused).toEqual([])
		expect((await generateSchema(url, schema, objects)).source).toContain('export interface DealsTable {')
	})

	test('the start check holds when the role sets standard_conforming_strings off and puts the schema first', async () => {
		const schema = await migrated('CREATE TABLE deals (id text PRIMARY KEY); CREATE FUNCTION shadow() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;')
		const role = `codegen_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
		const password = Bun.randomUUIDv7()
		const admin = new SQL({ url, adapter: 'postgres', max: 1 })
		try {
			await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
			await admin.unsafe(`ALTER ROLE ${role} SET standard_conforming_strings = off`)
			await admin.unsafe(`ALTER ROLE ${role} SET search_path = ${schema}, pg_catalog`)
			const hostile = new URL(url)
			hostile.username = role
			hostile.password = password
			await expect(introspectSchema(hostile.toString(), schema, [])).rejects.toThrow('function shadow (no migration declares it)')
		} finally {
			await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
			await admin.close()
		}
	})

	test('a trigger alone fails the start check unless a migration declares it', async () => {
		const schema = await migrated(`
			CREATE TABLE deals (id text PRIMARY KEY);
			CREATE TRIGGER noop BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();
		`)
		await expect(generateSchema(url, schema, [])).rejects.toThrow(
			`schema ${schema} holds database code that escapes it or that no migration declares: trigger deals.noop (no migration declares it);`,
		)
		expect((await generateSchema(url, schema, [{ kind: 'trigger', name: 'deals.noop' }])).source).toContain('export interface DealsTable {')
	})

	test('refuses a schema that was never migrated', async () => {
		await expect(introspectSchema(url, 'codegen_missing_schema', [])).rejects.toThrow(
			'schema codegen_missing_schema does not exist; run fabrika db migrate first',
		)
	})
})
