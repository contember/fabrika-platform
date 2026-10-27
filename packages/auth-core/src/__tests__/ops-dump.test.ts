// The dump format against a real SQLite (bun:sqlite): the schema rule, lossless values and a NULL-then-link load.
// The producer and the importer live elsewhere; the minimal ones here use only what the wire exports.
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import {
	decodeOpsDumpLine,
	encodeOpsDumpLine,
	encodeOpsDumpRow,
	foldOpsTableHash,
	OPS_DUMP_READ_COLUMNS,
	OPS_EMPTY_TABLE_HASH,
	OPS_SQLITE_MAX_COLUMNS,
	opsDumpColumnProjection,
	type OpsDumpPlan,
	opsDumpRowidSql,
	type OpsDumpSchema,
	type OpsDumpSchemaTable,
	type OpsDumpValue,
	opsDumpValueBinding,
	planOpsDump,
	readOpsDumpPage,
	readOpsDumpValue,
} from '../ops'

interface TableListRow {
	name: string
	type: string
	wr: number
}
interface ColumnRow {
	name: string
	type: string
	notnull: number
	pk: number
	hidden: number
}
interface IndexRow {
	name: string
	unique: number
	origin: string
	partial: number
}
interface IndexColumnRow {
	name: string | null
}
interface ForeignKeyRow {
	id: number
	table: string
	from: string
	to: string | null
}

const ORIGINS = ['c', 'u', 'pk'] as const

/** Reads the schema description with the PRAGMAs `OpsDumpSchema` names; CHECK and deferral come from the table's SQL. */
function readSchema(db: Database): OpsDumpSchema {
	const listed = db.query<TableListRow, []>(
		`SELECT name, type, wr FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual')
		AND (name NOT LIKE 'sqlite\\_%' ESCAPE '\\' OR name = 'sqlite_sequence') AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`,
	).all()
	return {
		tables: listed.map((row): OpsDumpSchemaTable => {
			const sql = db.query<{ sql: string | null }, [string]>(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(row.name)?.sql ?? ''
			const columns = db.query<ColumnRow, [string]>(`SELECT name, type, "notnull", pk, hidden FROM pragma_table_xinfo(?)`).all(row.name)
			const indexes = db.query<IndexRow, [string]>(`SELECT name, "unique", origin, partial FROM pragma_index_list(?)`).all(row.name)
			const keys = db.query<ForeignKeyRow, [string]>(`SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq`).all(row.name)
			const ids = [...new Set(keys.map((key) => key.id))]
			return {
				name: row.name,
				virtual: row.type === 'virtual',
				withoutRowid: row.wr === 1,
				// The application's reader lists the names a CHECK reads; this one cannot tell, so a CHECK names every column.
				checkNames: /\bCHECK\b/i.test(sql) ? null : [],
				columns: columns.map((column) => ({
					name: column.name,
					type: column.type,
					notNull: column.notnull === 1,
					primaryKey: column.pk,
					generated: column.hidden === 2 || column.hidden === 3,
				})),
				indexes: indexes.map((index) => ({
					unique: index.unique === 1,
					origin: ORIGINS.find((origin) => origin === index.origin) ?? 'c',
					partial: index.partial === 1,
					columns: db.query<IndexColumnRow, [string]>(`SELECT name FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno`).all(index.name).map((
						column,
					) => column.name),
				})),
				foreignKeys: ids.map((id) => {
					const rows = keys.filter((key) => key.id === id)
					const to = rows.map((key) => key.to)
					return {
						parent: rows[0]?.table ?? '',
						columns: rows.map((key) => key.from),
						references: to.every((column): column is string => column !== null) ? to : null,
						initiallyDeferred: /\bINITIALLY\s+DEFERRED\b/i.test(sql),
					}
				}),
			}
		}),
	}
}

function database(ddl: string): Database {
	const db = new Database(':memory:')
	db.run('PRAGMA foreign_keys = ON')
	db.run(ddl)
	return db
}

function plan(db: Database): OpsDumpPlan {
	const result = planOpsDump(readSchema(db))
	if ('refused' in result) throw new Error(`refused ${result.table}`)
	return result
}

function refusal(ddl: string): unknown {
	const result = planOpsDump(readSchema(database(ddl)))
	return 'refused' in result ? result : null
}

function quote(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}

/** Every value of a projected row: pairs of `typeof()` and the lossless form. */
function values(row: readonly unknown[]): OpsDumpValue[] {
	const out: OpsDumpValue[] = []
	for (let index = 0; index < row.length; index += 2) out.push(readOpsDumpValue(row[index], row[index + 1]))
	return out
}

/** The lines of a dump of `db` in the plan's order, each table in keyset order. */
function dump(db: Database, dumpPlan: OpsDumpPlan): string[] {
	const lines: string[] = []
	for (const table of dumpPlan.tables) {
		const projection = [table.keyset, ...table.columns].map(opsDumpColumnProjection).join(', ')
		const rows = db.prepare(`SELECT ${projection} FROM ${quote(table.name)} ORDER BY ${quote(table.keyset)}`).values()
		for (const row of rows) lines.push(encodeOpsDumpLine({ table: table.name, row: values(row) }))
	}
	return lines
}

/** The hash of each table, folded over its rows' canonical encodings. */
function hashes(lines: readonly string[]): Map<string, string> {
	const out = new Map<string, string>()
	for (const text of lines) {
		const line = decodeOpsDumpLine(text)
		if (line === null) throw new Error('a dump line does not decode')
		out.set(line.table, foldOpsTableHash(out.get(line.table) ?? OPS_EMPTY_TABLE_HASH, [encodeOpsDumpRow(line.row)]))
	}
	return out
}

/** Loads lines into a fresh database with the source's DDL: deferred columns `NULL` first, then a link pass by rowid. */
function load(source: Database, dumpPlan: OpsDumpPlan, lines: readonly string[]): Database {
	const target = new Database(':memory:')
	target.run('PRAGMA foreign_keys = ON')
	for (const { sql } of source.query<{ sql: string }, []>(`SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid`).all()) target.run(sql)
	const links: { table: string; keyset: string; rowid: OpsDumpValue; values: [string, OpsDumpValue][] }[] = []
	target.transaction(() => {
		for (const text of lines) {
			const line = decodeOpsDumpLine(text)
			const table = dumpPlan.tables.find((entry) => entry.name === line?.table)
			if (line === null || table === undefined) throw new Error('a line names no planned table')
			const [rowid, ...columns] = line.row
			// An INTEGER PRIMARY KEY repeats the rowid, and is written once, as the keyset.
			const written = table.columns.flatMap((name, index): [string, OpsDumpValue][] =>
				name === table.keyset ? [] : [[name, table.deferred.includes(name) ? null : (columns[index] ?? null)]]
			)
			const bindings = [rowid ?? null, ...written.map(([, value]) => value)].map(opsDumpValueBinding)
			const names = [table.keyset, ...written.map(([name]) => name)].map(quote).join(', ')
			target.prepare(`INSERT INTO ${quote(table.name)} (${names}) VALUES (${bindings.map((binding) => binding.sql).join(', ')})`).run(
				...bindings.map((binding) => binding.param),
			)
			const deferred = table.columns.flatMap((name, index): [string, OpsDumpValue][] =>
				table.deferred.includes(name) ? [[name, columns[index] ?? null]] : []
			)
			if (deferred.length > 0) links.push({ table: table.name, keyset: table.keyset, rowid: rowid ?? null, values: deferred })
		}
	})()
	target.transaction(() => {
		for (const link of links) {
			const sets = link.values.map(([name, value]) => ({ name, binding: opsDumpValueBinding(value) }))
			const key = opsDumpValueBinding(link.rowid)
			target.prepare(
				`UPDATE ${quote(link.table)} SET ${sets.map((set) => `${quote(set.name)} = ${set.binding.sql}`).join(', ')} WHERE ${
					quote(link.keyset)
				} = ${key.sql}`,
			)
				.run(...sets.map((set) => set.binding.param), key.param)
		}
	})()
	return target
}

/** Dumps `source`, loads it into a fresh database with foreign keys on, and expects the same lines and hashes back. */
function expectRoundTrip(source: Database): void {
	expect(source.query('PRAGMA foreign_key_check').all()).toEqual([])
	const dumpPlan = plan(source)
	const lines = dump(source, dumpPlan)
	const target = load(source, dumpPlan, lines)
	expect(target.query('PRAGMA foreign_key_check').all()).toEqual([])
	expect(plan(target)).toEqual(dumpPlan)
	expect(dump(target, dumpPlan)).toEqual(lines)
	expect(hashes(dump(target, dumpPlan))).toEqual(hashes(lines))
}

describe('the schema rule refuses what a NULL-then-link load cannot write', () => {
	test('a NOT NULL foreign key inside a cycle, of the table itself or across tables', () => {
		expect(refusal('CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES nodes (id))')).toEqual({
			refused: 'unsupported_schema',
			table: 'nodes',
		})
		expect(refusal(`
			CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER NOT NULL REFERENCES b (id));
			CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a (id));
		`)).toEqual({ refused: 'unsupported_schema', table: 'a' })
	})

	test('a nullable cycle column in a table with a CHECK, which a temporary NULL may violate', () => {
		expect(refusal('CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES nodes (id), CHECK (parent IS NOT NULL))')).toEqual({
			refused: 'unsupported_schema',
			table: 'nodes',
		})
	})

	test('a cycle column a CHECK names, a generated column a CHECK names, or a reader that cannot tell', () => {
		const ddl = `CREATE TABLE invoices (id TEXT PRIMARY KEY, kind TEXT, proforma_id TEXT REFERENCES invoices (id),
			label TEXT AS (kind || coalesce(proforma_id, '')))`
		const withChecks = (checkNames: readonly string[] | null) => {
			const schema = readSchema(database(ddl))
			return planOpsDump({ tables: schema.tables.map((table) => ({ ...table, checkNames })) })
		}
		for (const checkNames of [['proforma_id', 'is', 'not', 'null'], ['label', 'like', 'x'], ['PROFORMA_ID'.toLowerCase()], null]) {
			expect(withChecks(checkNames)).toEqual({ refused: 'unsupported_schema', table: 'invoices' })
		}
		expect(withChecks(['kind', 'in'])).toMatchObject({ tables: [{ name: 'invoices', deferred: ['proforma_id'] }] })
	})

	test('a cycle column beside a unique index over a generated column, which may collide while the column is NULL', () => {
		expect(refusal(`
			CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES nodes (id), slot INTEGER AS (coalesce(parent, 0)));
			CREATE UNIQUE INDEX by_slot ON nodes (slot);
		`)).toEqual({ refused: 'unsupported_schema', table: 'nodes' })
	})

	test('a cycle whose parent key is itself a cycle column: a.k and b.k reference each other', () => {
		expect(refusal(`
			CREATE TABLE a (id INTEGER PRIMARY KEY, k TEXT UNIQUE REFERENCES b (k));
			CREATE TABLE b (id INTEGER PRIMARY KEY, k TEXT UNIQUE REFERENCES a (k));
		`)).toEqual({ refused: 'unsupported_schema', table: 'a' })
	})

	test('a cycle column another foreign key references as its parent key', () => {
		expect(refusal(`
			CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent TEXT UNIQUE REFERENCES nodes (code), code TEXT UNIQUE);
			CREATE TABLE tags (id INTEGER PRIMARY KEY, node TEXT REFERENCES nodes (parent));
		`)).toEqual({ refused: 'unsupported_schema', table: 'nodes' })
	})

	test('a foreign key checked only at commit, whose violation would end the request and reset the object', () => {
		expect(refusal(`
			CREATE TABLE authors (id INTEGER PRIMARY KEY);
			CREATE TABLE notes (id INTEGER PRIMARY KEY, author INTEGER REFERENCES authors (id) DEFERRABLE INITIALLY DEFERRED);
		`)).toEqual({ refused: 'unsupported_schema', table: 'notes' })
	})

	test('a composite foreign key inside a cycle unless every column is nullable and none is a referenced key', () => {
		expect(refusal(`
			CREATE TABLE cells (x INTEGER NOT NULL, y INTEGER NOT NULL, px INTEGER NOT NULL, py INTEGER, UNIQUE (x, y),
				FOREIGN KEY (px, py) REFERENCES cells (x, y));
		`)).toEqual({ refused: 'unsupported_schema', table: 'cells' })
		expect(refusal(`
			CREATE TABLE cells (x INTEGER, y INTEGER, px INTEGER, py INTEGER, UNIQUE (x, y), UNIQUE (px, py),
				FOREIGN KEY (px, py) REFERENCES cells (x, y), FOREIGN KEY (x, y) REFERENCES cells (px, py));
		`)).toEqual({ refused: 'unsupported_schema', table: 'cells' })
	})

	test('a cycle column under a partial or expression unique index, or beside a NOT NULL generated column', () => {
		for (
			const ddl of [
				`CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES nodes (id), kind TEXT);
				CREATE UNIQUE INDEX one_root ON nodes (kind) WHERE parent IS NULL;`,
				`CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES nodes (id));
				CREATE UNIQUE INDEX by_parent ON nodes (coalesce(parent, 0));`,
				'CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES nodes (id), depth INTEGER NOT NULL AS (parent + 1))',
				'CREATE TABLE nodes (id INTEGER PRIMARY KEY REFERENCES nodes (id))',
			]
		) {
			expect(refusal(ddl)).toEqual({ refused: 'unsupported_schema', table: 'nodes' })
		}
	})

	test('a table without a rowid, without a name that reads it, or with a foreign key to a table outside the dump', () => {
		expect(refusal('CREATE TABLE kv (k TEXT PRIMARY KEY, v) WITHOUT ROWID')).toEqual({ refused: 'unsupported_schema', table: 'kv' })
		expect(refusal('CREATE TABLE shadowed (rowid TEXT, _rowid_ TEXT, oid TEXT, v)')).toEqual({ refused: 'unsupported_schema', table: 'shadowed' })
		expect(refusal('CREATE TABLE notes (id INTEGER PRIMARY KEY, author INTEGER REFERENCES authors (id))')).toEqual({
			refused: 'unsupported_schema',
			table: 'notes',
		})
		expect(refusal('CREATE TABLE notes (id INTEGER PRIMARY KEY, author INTEGER REFERENCES keyless)\n;CREATE TABLE keyless (v)')).toEqual({
			refused: 'unsupported_schema',
			table: 'notes',
		})
		expect(refusal('CREATE TABLE "Notes" (id INTEGER PRIMARY KEY)')).toEqual({ refused: 'unsupported_schema', table: null })
		const plain: OpsDumpSchemaTable = { name: 'docs', virtual: true, withoutRowid: false, checkNames: [], columns: [], indexes: [], foreignKeys: [] }
		expect(planOpsDump({ tables: [plain] })).toEqual({ refused: 'unsupported_schema', table: 'docs' })
	})
})

describe('the schema rule plans what it accepts', () => {
	test('an acyclic graph loads parents first, whatever the names', () => {
		const db = database(`
			CREATE TABLE z_authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
			CREATE TABLE m_notes (id INTEGER PRIMARY KEY, author INTEGER NOT NULL REFERENCES z_authors (id), body TEXT);
			CREATE TABLE a_comments (id INTEGER PRIMARY KEY, note INTEGER NOT NULL REFERENCES m_notes (id), extra INTEGER AS (id * 2));
		`)
		expect(plan(db)).toEqual({
			tables: [
				{ name: 'z_authors', keyset: 'id', columns: ['id', 'name'], deferred: [] },
				{ name: 'm_notes', keyset: 'id', columns: ['id', 'author', 'body'], deferred: [] },
				{ name: 'a_comments', keyset: 'id', columns: ['id', 'note'], deferred: [] },
			],
		})
		db.run(
			`INSERT INTO z_authors VALUES (2, 'b'), (1, 'a'); INSERT INTO m_notes VALUES (5, 2, 'x'), (4, 1, NULL); INSERT INTO a_comments (id, note) VALUES (9, 4)`,
		)
		expectRoundTrip(db)
	})

	test('a table outside a cycle that depends on one keeps its NOT NULL key, which the order satisfies', () => {
		const db = database(`
			CREATE TABLE a_leaf (id INTEGER PRIMARY KEY, z INTEGER NOT NULL REFERENCES z1 (id));
			CREATE TABLE z1 (id INTEGER PRIMARY KEY, other INTEGER REFERENCES z2 (id));
			CREATE TABLE z2 (id INTEGER PRIMARY KEY, other INTEGER REFERENCES z1 (id));
		`)
		expect(plan(db).tables.map((table) => [table.name, table.deferred])).toEqual([['z1', ['other']], ['a_leaf', []], ['z2', ['other']]])
		db.run('PRAGMA foreign_keys = OFF')
		db.run('INSERT INTO z1 VALUES (1, 2), (2, NULL); INSERT INTO z2 VALUES (1, 2), (2, 1); INSERT INTO a_leaf VALUES (1, 2)')
		db.run('PRAGMA foreign_keys = ON')
		expectRoundTrip(db)
	})

	test('a self-referencing cycle whose rows point at later rows loads NULL, then links', () => {
		const db = database('CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES nodes (id), name TEXT NOT NULL)')
		expect(plan(db).tables).toEqual([{ name: 'nodes', keyset: 'id', columns: ['id', 'parent', 'name'], deferred: ['parent'] }])
		db.run('PRAGMA foreign_keys = OFF')
		db.run(`INSERT INTO nodes VALUES (1, 3, 'a'), (2, 2, 'self'), (3, NULL, 'root'), (4, 1, 'b')`)
		db.run('PRAGMA foreign_keys = ON')
		expectRoundTrip(db)
	})

	test('a multi-table cycle, a composite key in it included, loads NULL, then links', () => {
		const db = database(`
			CREATE TABLE people (id INTEGER PRIMARY KEY, team INTEGER REFERENCES teams (id), name TEXT);
			CREATE TABLE teams (id INTEGER PRIMARY KEY, lead INTEGER REFERENCES people (id), ox INTEGER, oy INTEGER,
				FOREIGN KEY (ox, oy) REFERENCES offices (x, y));
			CREATE TABLE offices (x INTEGER NOT NULL, y INTEGER NOT NULL, team INTEGER REFERENCES teams (id), UNIQUE (x, y));
		`)
		expect(plan(db).tables.map((table) => [table.name, table.deferred])).toEqual([
			['offices', ['team']],
			['people', ['team']],
			['teams', ['lead', 'ox', 'oy']],
		])
		db.run('PRAGMA foreign_keys = OFF')
		db.run(`
			INSERT INTO people VALUES (1, 2, 'p1'), (2, 1, 'p2'), (3, NULL, 'p3');
			INSERT INTO teams VALUES (1, 2, 5, 6), (2, 1, NULL, NULL);
			INSERT INTO offices VALUES (5, 6, 1), (7, 8, 2);
		`)
		db.run('PRAGMA foreign_keys = ON')
		expectRoundTrip(db)
	})

	test('reads the rowid by its INTEGER PRIMARY KEY, else by the first of rowid, _rowid_ and oid no column takes', () => {
		const db = database(`
			CREATE TABLE aliased (code INTEGER, v TEXT, PRIMARY KEY (code DESC));
			CREATE TABLE descending (code INTEGER PRIMARY KEY DESC, v TEXT);
			CREATE TABLE int_key (code INT PRIMARY KEY, v TEXT);
			CREATE TABLE partly (rowid TEXT, _rowid_ TEXT, v TEXT);
			CREATE TABLE plain (v TEXT);
		`)
		expect(plan(db).tables.map((table) => [table.name, table.keyset])).toEqual([
			['aliased', 'code'],
			['descending', 'rowid'],
			['int_key', 'rowid'],
			['partly', 'oid'],
			['plain', 'rowid'],
		])
		db.run(`
			INSERT INTO aliased VALUES (9223372036854775807, 'max'), (-9223372036854775808, 'min');
			INSERT INTO descending VALUES ('text key', 'x'), (3, 'y');
			INSERT INTO partly (rowid, _rowid_, v) VALUES ('dup', 'dup', 'a'), ('dup', 'dup', 'b');
			INSERT INTO plain (rowid, v) VALUES (9007199254740993, 'a');
		`)
		expectRoundTrip(db)
	})
})

describe('lossless values in SQLite', () => {
	/** Writes `literal` into a column of `columnType`, round-trips it through the wire and returns both sides. */
	function roundTrip(columnType: string, literal: string, strict = false): { source: unknown; target: unknown; value: OpsDumpValue } {
		const ddl = `CREATE TABLE t (c ${columnType})${strict ? ' STRICT' : ''}`
		const source = database(ddl)
		source.run(`INSERT INTO t (c) VALUES (${literal})`)
		const [projected] = source.prepare(`SELECT ${opsDumpColumnProjection('c')} FROM t`).values()
		const [value] = decodeRow(encodeOpsDumpRow(values(projected ?? [])))
		const target = database(ddl)
		const binding = opsDumpValueBinding(value ?? null)
		target.prepare(`INSERT INTO t (c) VALUES (${binding.sql})`).run(binding.param)
		const read = `SELECT typeof(c) AS type, CAST(c AS TEXT) AS text, hex(CAST(c AS BLOB)) AS bytes, c FROM t`
		return { source: source.query(read).get(), target: target.query(read).get(), value: value ?? null }
	}

	function decodeRow(text: string): readonly OpsDumpValue[] {
		const line = decodeOpsDumpLine(`{"table":"t","row":${text}}`)
		if (line === null) throw new Error('the row does not decode')
		return line.row
	}

	test('keeps every byte of text, malformed UTF-8, a lone surrogate, NUL and non-BMP text included', () => {
		for (const bytes of ['80', '81', 'EDA080', '610062', 'F09F9880', '']) {
			const { source, target, value } = roundTrip('TEXT', `CAST(x'${bytes}' AS TEXT)`)
			expect(value).toEqual({ type: 'text', value: bytes })
			expect(target).toEqual(source)
			expect(target).toMatchObject({ type: 'text', bytes })
		}
	})

	test('tells apart text that a JavaScript string would make equal', () => {
		const db = database('CREATE TABLE t (c TEXT)')
		db.run(`INSERT INTO t VALUES (CAST(x'80' AS TEXT)), (CAST(x'81' AS TEXT))`)
		const strings = db.query<{ c: string }, []>('SELECT c FROM t ORDER BY rowid').all().map((row) => row.c)
		expect(strings[0]).toBe(strings[1] ?? '')
		const rows = db.prepare(`SELECT ${opsDumpColumnProjection('c')} FROM t ORDER BY rowid`).values().map((row) => encodeOpsDumpRow(values(row)))
		expect(rows).toEqual(['["t:80"]', '["t:81"]'])
		expect(foldOpsTableHash(OPS_EMPTY_TABLE_HASH, rows.slice(0, 1))).not.toBe(foldOpsTableHash(OPS_EMPTY_TABLE_HASH, rows.slice(1)))
	})

	test('keeps the storage class and value of int64 extrema and 2^53 + 1 in an INTEGER, an ANY and an untyped column', () => {
		for (const integer of ['-9223372036854775808', '9223372036854775807', '9007199254740993']) {
			for (const [columnType, strict] of [['INTEGER', false], ['ANY', true], ['', false]] as const) {
				const { source, target, value } = roundTrip(columnType, integer, strict)
				expect(value).toEqual({ type: 'integer', value: integer })
				expect(target).toEqual(source)
				expect(target).toMatchObject({ type: 'integer', text: integer })
			}
		}
	})

	test('binding decimal text without the cast would store text in an untyped column', () => {
		const db = database('CREATE TABLE t (c)')
		db.prepare('INSERT INTO t VALUES (?)').run('9007199254740993')
		expect(db.query('SELECT typeof(c) AS type FROM t').get()).toEqual({ type: 'text' })
	})

	test('keeps a real a real, an integral one and a negative zero included', () => {
		for (const literal of ['3.0', '-0.0', '0.1', '1e308', '5e-324', '9e999', '-9e999']) {
			const { source, target, value } = roundTrip('', literal)
			expect(value?.type).toBe('real')
			expect(target).toEqual(source)
			expect(target).toMatchObject({ type: 'real' })
		}
	})

	test('keeps a blob and NULL', () => {
		expect(roundTrip('BLOB', `x'00FF10'`).target).toMatchObject({ type: 'blob', bytes: '00FF10' })
		expect(roundTrip('BLOB', `x''`).target).toMatchObject({ type: 'blob', bytes: '' })
		expect(roundTrip('TEXT', 'NULL').target).toMatchObject({ type: 'null' })
	})

	test('refuses a projected pair it would not produce', () => {
		for (const [type, value] of [['integer', 3], ['real', '0.1'], ['text', 'hi'], ['blob', 'ab'], ['null', 0], ['real', Number.NaN]] as const) {
			expect(() => readOpsDumpValue(type, value)).toThrow(/^(?!.*hi)/)
		}
	})
})

describe("a page read stays within workerd's column limit", () => {
	const wide = { name: 'wide', keyset: 'rowid', columns: Array.from({ length: 100 }, (_, index) => `c${index}`), deferred: [] }

	test('a table at the limit reads in statements of at most 100 result columns, joined by rowid', () => {
		const database = new Database(':memory:')
		database.run(`CREATE TABLE wide (${wide.columns.join(', ')})`)
		database.run(`INSERT INTO wide (rowid, c0, c49, c50, c99) VALUES (7, 1, 'a', 2.5, x'FF')`)
		const statements: number[] = []
		const rows = readOpsDumpPage(
			(sql) => {
				const statement = database.prepare<Record<string, unknown>, []>(sql)
				statements.push(statement.columnNames.length)
				return statement.all()
			},
			wide,
			'',
			10,
		)

		expect(statements).toEqual([1 + 2 * OPS_DUMP_READ_COLUMNS, 1 + 2 * OPS_DUMP_READ_COLUMNS, 1 + 2 * 2])
		expect(Math.max(...statements)).toBeLessThanOrEqual(OPS_SQLITE_MAX_COLUMNS)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.rowid).toBe('7')
		expect(rows[0]?.values).toHaveLength(101)
		expect(rows[0]?.values[1]).toEqual({ type: 'integer', value: '1' })
		expect(rows[0]?.values[50]).toEqual({ type: 'text', value: '61' })
		expect(rows[0]?.values[51]).toEqual({ type: 'real', value: 2.5 })
		expect(rows[0]?.values[100]).toEqual({ type: 'blob', value: 'FF' })
	})

	test('statements that disagree on their rows are refused, never joined', () => {
		const nulls = Object.fromEntries(wide.columns.flatMap((_, index) => [[`t${index}`, 'null'], [`v${index}`, null]]))
		let call = 0
		const read = () => {
			call++
			return [{ ...nulls, r: call === 2 ? '8' : '7' }]
		}
		expect(() => readOpsDumpPage(read, wide, '', 10)).toThrow('the reads of one dump page disagree on its rows')
		call = 0
		expect(() => readOpsDumpPage(() => (++call === 3 ? [] : [{ ...nulls, r: '7' }]), wide, '', 10)).toThrow(
			'the reads of one dump page disagree on its rows',
		)
	})

	test('a rowid is named inline only as the checked text of a 64-bit integer', () => {
		expect(opsDumpRowidSql({ type: 'integer', value: '-9223372036854775808' })).toBe(`CAST('-9223372036854775808' AS INTEGER)`)
		expect(() => opsDumpRowidSql({ type: 'integer', value: "1' OR 1 = 1 --" })).toThrow()
		expect(() => opsDumpRowidSql({ type: 'text', value: '31' })).toThrow()
		expect(() => opsDumpRowidSql(null)).toThrow()
	})
})
