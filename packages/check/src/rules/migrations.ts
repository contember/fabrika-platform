import {
	afterName,
	closingParenthesis,
	isPunct,
	lexSqlite,
	nameText,
	objectNameAt,
	skipWords,
	splitAtCommas,
	type SqlToken,
	statementsOf,
	topLevelStatements,
	upperWord,
} from '@fabrika/platform-node/sql'
import type { Finding } from '../finding'
import { MIGRATIONS_DIR, TABLES_FILE } from '../layout'

const MIGRATION_NAME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/
const ALLOWED = 'db/migrations/YYYYMMDDHHMMSS_slug.sql with a lowercase snake_case slug, as fabrika db new <slug> writes it'

const isValidTimestamp = (parts: readonly string[]): boolean => {
	const [year, month, day, hour, minute, second] = parts.map(Number)
	if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) {
		return false
	}
	const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour < 24 && minute < 60 && second < 60
}

/** Migration file names sort by creation time, so parallel worktrees never claim the same name. */
export const checkMigrationNames = (paths: readonly string[]): Finding[] => {
	const findings: Finding[] = []
	for (const path of paths) {
		if (!path.startsWith(MIGRATIONS_DIR)) continue
		const name = path.slice(MIGRATIONS_DIR.length)
		const match = MIGRATION_NAME.exec(name)
		if (match !== null && isValidTimestamp(match.slice(1, 7))) continue
		const message = name.includes('/')
			? `'${name}' is in a subdirectory of db/migrations`
			: match === null
			? `'${name}' is not a migration file name`
			: `'${name}' does not start with a real UTC timestamp`
		findings.push({ file: path, line: 1, column: 1, severity: 'refusal', rule: 'migration-name', message, allowed: ALLOWED })
	}
	return findings
}

/** The default a SQLite timestamp column takes: the UTC ISO text every read of the table parses. */
const SQLITE_NOW_DEFAULT = "DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"

/**
 * On SQLite `DEFAULT CURRENT_TIMESTAMP` stores `YYYY-MM-DD HH:MM:SS`, which every read of the table refuses as
 * `unexpected_row` (backlog 216 item 13). Refused with or without parentheses, at the line of `CURRENT_TIMESTAMP`.
 */
export const checkCurrentTimestampDefaults = (files: ReadonlyMap<string, string>): Finding[] => {
	const findings: Finding[] = []
	for (const [path, sql] of files) {
		if (!path.startsWith(MIGRATIONS_DIR) || !path.endsWith('.sql')) continue
		for (const { tokens } of statementsOf(lexSqlite(sql).tokens)) {
			tokens.forEach((token, index) => {
				if (upperWord(token) !== 'DEFAULT') return
				const value = isPunct(tokens[index + 1], '(') ? tokens[index + 2] : tokens[index + 1]
				if (value === undefined || upperWord(value) !== 'CURRENT_TIMESTAMP') return
				findings.push({
					file: path,
					line: value.line,
					column: 1,
					severity: 'refusal',
					rule: 'cloudflare-current-timestamp',
					message: 'DEFAULT CURRENT_TIMESTAMP stores YYYY-MM-DD HH:MM:SS on SQLite, which every read of the table refuses as unexpected_row',
					allowed: SQLITE_NOW_DEFAULT,
				})
			})
		}
	}
	return findings
}

/**
 * On SQLite an application migration runs verbatim, with no name rule, so a view or a trigger over a framework table
 * would reach what `ctx.sql`'s name rule keeps it from. Every `fabrika_*` name is refused (any case, quoted, bracketed,
 * or as a string SQLite may read as a name) but `fabrika_files` right after `REFERENCES`, a file column's foreign key.
 */
export const checkSqliteFrameworkNames = (files: ReadonlyMap<string, string>): Finding[] => {
	const findings: Finding[] = []
	for (const [path, sql] of files) {
		if (!path.startsWith(MIGRATIONS_DIR) || !path.endsWith('.sql')) continue
		for (const { tokens } of statementsOf(lexSqlite(sql).tokens)) {
			tokens.forEach((token, index) => {
				const text = token.kind === 'word' || token.kind === 'quoted' || token.kind === 'string' ? token.text : undefined
				const name = text?.toLowerCase()
				if (name === undefined || !name.startsWith('fabrika_')) return
				if (name === FILES_TABLE && token.kind !== 'string' && upperWord(tokens[index - 1]) === 'REFERENCES') return
				findings.push({
					file: path,
					line: token.line,
					column: 1,
					severity: 'refusal',
					rule: 'cloudflare-framework-name',
					message: `'${text}' is the framework's: a migration on Cloudflare names no fabrika_* table, which ctx.sql could then reach through it`,
					allowed: `the application's own tables, and REFERENCES ${FILES_TABLE} (id) for a file column`,
				})
			})
		}
	}
	return findings
}

/**
 * A view is read-only (ADR-0072); on SQLite an INSTEAD OF trigger would make a view writable, so it is refused. SQLite
 * takes INSTEAD OF only on a view, so the timing alone, written before the trigger's `ON`, names one.
 */
export const checkSqliteViewTriggers = (files: ReadonlyMap<string, string>): Finding[] => {
	const findings: Finding[] = []
	for (const [path, sql] of files) {
		if (!path.startsWith(MIGRATIONS_DIR) || !path.endsWith('.sql')) continue
		for (const { tokens } of statementsOf(lexSqlite(sql).tokens)) {
			if (upperWord(tokens[0]) !== 'CREATE') continue
			const at = skipWords(tokens, skipWords(tokens, 1, 'TEMP'), 'TEMPORARY')
			if (upperWord(tokens[at]) !== 'TRIGGER') continue
			for (let index = at + 1; index < tokens.length && upperWord(tokens[index]) !== 'ON'; index++) {
				const token = tokens[index]
				if (token === undefined || upperWord(token) !== 'INSTEAD' || upperWord(tokens[index + 1]) !== 'OF') continue
				findings.push({
					file: path,
					line: token.line,
					column: 1,
					severity: 'refusal',
					rule: 'cloudflare-view-trigger',
					message: 'an INSTEAD OF trigger makes a view writable, and a view is read-only (ADR-0072)',
					allowed: 'a view without triggers, written through its source tables',
				})
				break
			}
		}
	}
	return findings
}

/** A declared file column: `table.column` holds files of `kind`. */
export interface FileColumn {
	readonly table: string
	readonly column: string
	readonly kind: string
}

const FILES_TABLE = 'fabrika_files'
const TABLE_CONSTRAINTS = new Set(['CONSTRAINT', 'FOREIGN', 'UNIQUE', 'PRIMARY', 'CHECK', 'EXCLUDE', 'LIKE'])

/** What the migrations, in order, declare of each `table.column`: a foreign key to `fabrika_files`, and the indexes it leads. */
interface FileColumnDdl {
	readonly references: Set<string>
	readonly indexes: { readonly name: string | undefined; readonly key: string }[]
	readonly created: Map<string, { readonly path: string; readonly line: number }>
}

/**
 * Every declared file column needs a foreign key to `fabrika_files (id)`, which keeps the sweep from deleting a file a
 * row references, and an index it leads, which the sweep's reference check and each file deletion read. Only what a
 * migration creates counts: a `REFERENCES fabrika_files` on the column or a one-column foreign key, and a `CREATE
 * INDEX` without `WHERE`, a `UNIQUE` or a `PRIMARY KEY` whose first column it is, minus a later `DROP INDEX`.
 */
export const checkFileColumnMigrations = (files: ReadonlyMap<string, string>, columns: readonly FileColumn[]): Finding[] => {
	if (columns.length === 0) {
		return []
	}
	const ddl: FileColumnDdl = { references: new Set(), indexes: [], created: new Map() }
	const migrations = [...files.entries()]
		.filter(([path]) => path.startsWith(MIGRATIONS_DIR) && path.endsWith('.sql'))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	for (const [path, sql] of migrations) {
		for (const statement of topLevelStatements(sql)) {
			readFileColumnDdl(path, statement.tokens, statement.line, ddl)
		}
	}
	const indexed = new Set(ddl.indexes.map((index) => index.key))
	const findings: Finding[] = []
	for (const { table, column, kind } of columns) {
		const key = `${table}.${column}`
		const at = ddl.created.get(table) ?? { path: MIGRATIONS_DIR, line: 1 }
		const missing = [
			ddl.references.has(key) ? undefined : `no migration makes it a foreign key to ${FILES_TABLE} (id)`,
			indexed.has(key) ? undefined : 'no migration creates an index it leads',
		].filter((reason) => reason !== undefined)
		if (missing.length === 0) continue
		findings.push({
			file: at.path,
			line: at.line,
			column: 1,
			severity: 'refusal',
			rule: 'file-column-migration',
			message: `${key} holds files of kind '${kind}', and ${missing.join(', and ')}`,
			allowed: `${column} uuid references ${FILES_TABLE} (id) in a migration, and create index ${table}_${column} on ${table} (${column})`,
		})
	}
	return findings
}

function readFileColumnDdl(path: string, tokens: readonly SqlToken[], line: number, ddl: FileColumnDdl): void {
	const verb = upperWord(tokens[0])
	const object = upperWord(tokens[1])
	if (verb === 'CREATE' && object === 'TABLE') {
		const at = skipWords(tokens, 2, 'IF', 'NOT', 'EXISTS')
		const table = objectNameAt(tokens, at)?.name
		const open = afterName(tokens, at)
		const close = open === undefined ? undefined : closingParenthesis(tokens, open)
		if (table === undefined || open === undefined || close === undefined) return
		ddl.created.set(table, { path, line })
		for (const element of splitAtCommas(tokens.slice(open + 1, close))) {
			readTableElement(table, element, ddl)
		}
	} else if (verb === 'ALTER' && object === 'TABLE') {
		const at = skipWords(tokens, skipWords(tokens, 2, 'IF', 'EXISTS'), 'ONLY')
		const table = objectNameAt(tokens, at)?.name
		const end = afterName(tokens, at)
		if (table === undefined || end === undefined) return
		for (const action of splitAtCommas(tokens.slice(end))) {
			if (upperWord(action[0]) !== 'ADD') continue
			readTableElement(table, action.slice(skipWords(action, skipWords(action, 1, 'COLUMN'), 'IF', 'NOT', 'EXISTS')), ddl)
		}
	} else if (verb === 'CREATE' && (object === 'INDEX' || (object === 'UNIQUE' && upperWord(tokens[2]) === 'INDEX'))) {
		readIndex(tokens.slice(object === 'UNIQUE' ? 3 : 2), ddl)
	} else if (verb === 'DROP' && object === 'INDEX') {
		const at = skipWords(tokens, skipWords(tokens, 2, 'CONCURRENTLY'), 'IF', 'EXISTS')
		const dropped = new Set(splitAtCommas(tokens.slice(at)).map((part) => objectNameAt(part, 0)?.name))
		const kept = ddl.indexes.filter((index) => index.name === undefined || !dropped.has(index.name))
		ddl.indexes.splice(0, ddl.indexes.length, ...kept)
	}
}

/** A column definition, or a table constraint: what it says of a file column of `table`. */
function readTableElement(table: string, element: readonly SqlToken[], ddl: FileColumnDdl): void {
	const head = upperWord(element[0])
	if (head !== undefined && TABLE_CONSTRAINTS.has(head)) {
		readTableConstraint(table, head === 'CONSTRAINT' ? element.slice(2) : element, ddl)
		return
	}
	const column = nameText(element[0])
	if (column === undefined) return
	const key = `${table}.${column}`
	const rest = element.slice(1)
	if (referencesFiles(rest)) ddl.references.add(key)
	if (depthZeroWords(rest).some((word) => word === 'UNIQUE' || word === 'PRIMARY')) ddl.indexes.push({ name: undefined, key })
}

function readTableConstraint(table: string, constraint: readonly SqlToken[], ddl: FileColumnDdl): void {
	const kind = upperWord(constraint[0])
	const open = kind === 'FOREIGN' || kind === 'PRIMARY'
		? 2
		: kind === 'UNIQUE'
		? afterNullsClause(constraint)
		: undefined
	const list = open === undefined ? undefined : columnList(constraint, open)
	const [first] = list?.columns ?? []
	if (list === undefined || first === undefined) return
	if (kind !== 'FOREIGN') {
		ddl.indexes.push({ name: undefined, key: `${table}.${first}` })
	} else if (list.columns.length === 1 && referencesFiles(constraint.slice(list.end))) {
		ddl.references.add(`${table}.${first}`)
	}
}

/** The index past `UNIQUE [NULLS [NOT] DISTINCT]`. */
function afterNullsClause(constraint: readonly SqlToken[]): number {
	const notDistinct = skipWords(constraint, 1, 'NULLS', 'NOT', 'DISTINCT')
	return notDistinct === 1 ? skipWords(constraint, 1, 'NULLS', 'DISTINCT') : notDistinct
}

/** `[name] ON [ONLY] table [USING method] (first, …)`, after `CREATE [UNIQUE] INDEX`; a partial index serves no reference check. */
function readIndex(tokens: readonly SqlToken[], ddl: FileColumnDdl): void {
	let at = skipWords(tokens, skipWords(tokens, 0, 'CONCURRENTLY'), 'IF', 'NOT', 'EXISTS')
	const name = upperWord(tokens[at]) === 'ON' ? undefined : objectNameAt(tokens, at)?.name
	at = name === undefined ? at : (afterName(tokens, at) ?? at)
	if (upperWord(tokens[at]) !== 'ON') return
	at = skipWords(tokens, at + 1, 'ONLY')
	const table = objectNameAt(tokens, at)?.name
	const after = afterName(tokens, at)
	if (table === undefined || after === undefined) return
	const list = columnList(tokens, upperWord(tokens[after]) === 'USING' ? after + 2 : after)
	const [first] = list?.columns ?? []
	if (list === undefined || first === undefined || depthZeroWords(tokens.slice(list.end)).includes('WHERE')) return
	ddl.indexes.push({ name, key: `${table}.${first}` })
}

/** The leading names of a parenthesized list at `open` (an expression has none), and the index past it. */
function columnList(
	tokens: readonly SqlToken[],
	open: number,
): { readonly columns: readonly (string | undefined)[]; readonly end: number } | undefined {
	const close = isPunct(tokens[open], '(') ? closingParenthesis(tokens, open) : undefined
	if (close === undefined) return undefined
	const columns = splitAtCommas(tokens.slice(open + 1, close)).map((part) => (isPunct(part[1], '(') ? undefined : nameText(part[0])))
	return { columns, end: close + 1 }
}

/** `REFERENCES fabrika_files` or `REFERENCES fabrika_files (id)` among `tokens`, at parenthesis depth 0. */
function referencesFiles(tokens: readonly SqlToken[]): boolean {
	let depth = 0
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		if (isPunct(token, '(')) depth++
		else if (isPunct(token, ')')) depth--
		if (depth !== 0 || upperWord(token) !== 'REFERENCES') continue
		const target = objectNameAt(tokens, index + 1)
		const after = afterName(tokens, index + 1)
		if (target === undefined || after === undefined || target.qualifier !== undefined || target.name !== FILES_TABLE) return false
		return !isPunct(tokens[after], '(') || (nameText(tokens[after + 1]) === 'id' && isPunct(tokens[after + 2], ')'))
	}
	return false
}

function depthZeroWords(tokens: readonly SqlToken[]): string[] {
	const words: string[] = []
	let depth = 0
	for (const token of tokens) {
		if (isPunct(token, '(')) depth++
		else if (isPunct(token, ')')) depth--
		const word = upperWord(token)
		if (depth === 0 && word !== undefined) words.push(word)
	}
	return words
}

/** An `insert(values, { onConflict: { columns } })` the source makes, with the finding it gets when no index fits. */
export interface ConflictInsert {
	readonly table: string
	readonly columns: readonly string[]
	readonly finding: Finding
}

/**
 * `onConflict.columns` must name a unique index the migrations create, or Postgres refuses the insert at run time: the
 * set of columns of a `UNIQUE` or `PRIMARY KEY` constraint, or of a `CREATE UNIQUE INDEX` without `WHERE` or expression,
 * minus a later `DROP INDEX`. Order does not matter, as for Postgres. Only a table `src/db/tables.ts` declares is
 * checked: another receiver of `insert` is no table of the data layer.
 */
export const checkConflictIndexes = (
	files: ReadonlyMap<string, string>,
	tables: ReadonlySet<string>,
	inserts: readonly ConflictInsert[],
): Finding[] => {
	const checked = inserts.filter((insert) => tables.has(insert.table))
	if (checked.length === 0) {
		return []
	}
	const unique: UniqueIndex[] = []
	const migrations = [...files.entries()]
		.filter(([path]) => path.startsWith(MIGRATIONS_DIR) && path.endsWith('.sql'))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	for (const [, sql] of migrations) {
		for (const statement of topLevelStatements(sql)) {
			readUniqueIndexes(statement.tokens, unique)
		}
	}
	const keyOf = (columns: readonly string[]): string => [...new Set(columns)].sort().join(',')
	const present = new Set(unique.map((index) => `${index.table}(${keyOf(index.columns)})`))
	return checked.filter((insert) => !present.has(`${insert.table}(${keyOf(insert.columns)})`)).map((insert) => insert.finding)
}

/** A table that names an access view under `key` (ADR-0076). */
export interface AccessKey {
	readonly table: string
	readonly key: string
	readonly views: readonly string[]
}

/**
 * A table that names an access view needs its key unique on its own, or the view's `row` names several rows at once
 * (ADR-0076 section 1). A view as the target keeps its key unique by its SQL; any other name no migration creates as a
 * table is refused, so a statement the reader does not follow fails closed.
 */
export const checkAccessViewKeys = (files: ReadonlyMap<string, string>, keys: readonly AccessKey[]): Finding[] => {
	if (keys.length === 0) {
		return []
	}
	const unique: UniqueIndex[] = []
	const created = new Map<string, { readonly path: string; readonly line: number }>()
	const views = new Set<string>()
	const migrations = [...files.entries()]
		.filter(([path]) => path.startsWith(MIGRATIONS_DIR) && path.endsWith('.sql'))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	for (const [path, sql] of migrations) {
		for (const statement of topLevelStatements(sql)) {
			readUniqueIndexes(statement.tokens, unique)
			const table = createdTable(statement.tokens)
			if (table !== undefined) created.set(table, { path, line: statement.line })
			const view = createdView(statement.tokens)
			if (view !== undefined) views.add(view)
			for (const dropped of droppedTables(statement.tokens)) created.delete(dropped)
			const renamed = renamedTable(statement.tokens)
			const at = renamed === undefined ? undefined : created.get(renamed.from)
			if (renamed !== undefined && at !== undefined) {
				created.delete(renamed.from)
				created.set(renamed.to, at)
			}
		}
	}
	const findings: Finding[] = []
	for (const { table, key, views: named } of keys) {
		const at = created.get(table)
		if (at === undefined && views.has(table)) continue
		if (at !== undefined && unique.some((index) => index.table === table && index.columns.length === 1 && index.columns[0] === key)) continue
		findings.push({
			file: at?.path ?? TABLES_FILE,
			line: at?.line ?? 1,
			column: 1,
			severity: 'refusal',
			rule: 'access-view-key',
			message: at === undefined
				? `${table} names the access view ${named.join(', ')}, and no migration creates ${table} as a table or a view`
				: `${table} names the access view ${named.join(', ')}, and no migration makes its key ${key} unique on its own`,
			allowed: `${key} as the primary key of ${table}, or create unique index ${table}_${key} on ${table} (${key})`,
		})
	}
	return findings
}

/** The table a `CREATE [UNLOGGED | TEMP | TEMPORARY] TABLE` statement creates. */
function createdTable(tokens: readonly SqlToken[]): string | undefined {
	if (upperWord(tokens[0]) !== 'CREATE') return undefined
	const at = skipOne(tokens, 1, 'UNLOGGED', 'TEMP', 'TEMPORARY')
	if (upperWord(tokens[at]) !== 'TABLE') return undefined
	return objectNameAt(tokens, skipWords(tokens, at + 1, 'IF', 'NOT', 'EXISTS'))?.name
}

/** The view a `CREATE [OR REPLACE] [TEMP] [MATERIALIZED] VIEW` statement creates. */
function createdView(tokens: readonly SqlToken[]): string | undefined {
	if (upperWord(tokens[0]) !== 'CREATE') return undefined
	const at = skipOne(tokens, skipOne(tokens, skipWords(tokens, 1, 'OR', 'REPLACE'), 'TEMP', 'TEMPORARY'), 'MATERIALIZED')
	if (upperWord(tokens[at]) !== 'VIEW') return undefined
	return objectNameAt(tokens, skipWords(tokens, at + 1, 'IF', 'NOT', 'EXISTS'))?.name
}

/** Past one of `words` at `at`, when the token there is one of them. */
function skipOne(tokens: readonly SqlToken[], at: number, ...words: readonly string[]): number {
	const word = upperWord(tokens[at])
	return word !== undefined && words.includes(word) ? at + 1 : at
}

/** The tables a `DROP TABLE` statement drops. */
function droppedTables(tokens: readonly SqlToken[]): string[] {
	if (upperWord(tokens[0]) !== 'DROP' || upperWord(tokens[1]) !== 'TABLE') return []
	const at = skipWords(tokens, 2, 'IF', 'EXISTS')
	return splitAtCommas(tokens.slice(at)).flatMap((part) => objectNameAt(part, 0)?.name ?? [])
}

/** `ALTER TABLE from RENAME TO to`. */
function renamedTable(tokens: readonly SqlToken[]): { readonly from: string; readonly to: string } | undefined {
	if (upperWord(tokens[0]) !== 'ALTER' || upperWord(tokens[1]) !== 'TABLE') return undefined
	const at = skipWords(tokens, skipWords(tokens, 2, 'IF', 'EXISTS'), 'ONLY')
	const from = objectNameAt(tokens, at)?.name
	const end = afterName(tokens, at)
	if (from === undefined || end === undefined || upperWord(tokens[end]) !== 'RENAME' || upperWord(tokens[end + 1]) !== 'TO') return undefined
	const to = objectNameAt(tokens, end + 2)?.name
	return to === undefined ? undefined : { from, to }
}

function defaultConstraintName(table: string, primary: boolean, columns: readonly string[]): string {
	return primary ? `${table}_pkey` : `${table}_${columns.join('_')}_key`
}

interface UniqueIndex {
	readonly name: string | undefined
	readonly table: string
	readonly columns: readonly string[]
}

function readUniqueIndexes(tokens: readonly SqlToken[], unique: UniqueIndex[]): void {
	const verb = upperWord(tokens[0])
	const object = upperWord(tokens[1])
	const keep = (kept: (index: UniqueIndex) => boolean) => unique.splice(0, unique.length, ...unique.filter(kept))
	const tableAt = verb === 'CREATE' ? skipOne(tokens, 1, 'UNLOGGED', 'TEMP', 'TEMPORARY') : 1
	if (verb === 'CREATE' && upperWord(tokens[tableAt]) === 'TABLE') {
		const at = skipWords(tokens, tableAt + 1, 'IF', 'NOT', 'EXISTS')
		const table = objectNameAt(tokens, at)?.name
		const open = afterName(tokens, at)
		const close = open === undefined ? undefined : closingParenthesis(tokens, open)
		if (table === undefined || open === undefined || close === undefined) return
		keep((index) => index.table !== table)
		for (const element of splitAtCommas(tokens.slice(open + 1, close))) {
			readUniqueElement(table, element, unique)
		}
	} else if (verb === 'DROP' && object === 'TABLE') {
		const dropped = new Set(splitAtCommas(tokens.slice(skipWords(tokens, 2, 'IF', 'EXISTS'))).map((part) => objectNameAt(part, 0)?.name))
		keep((index) => !dropped.has(index.table))
	} else if (verb === 'ALTER' && object === 'TABLE') {
		const at = skipWords(tokens, skipWords(tokens, 2, 'IF', 'EXISTS'), 'ONLY')
		const table = objectNameAt(tokens, at)?.name
		const end = afterName(tokens, at)
		if (table === undefined || end === undefined) return
		for (const action of splitAtCommas(tokens.slice(end))) {
			alterUnique(table, action, unique, keep)
		}
	} else if (verb === 'CREATE' && object === 'UNIQUE' && upperWord(tokens[2]) === 'INDEX') {
		const rest = tokens.slice(3)
		let at = skipWords(rest, skipWords(rest, 0, 'CONCURRENTLY'), 'IF', 'NOT', 'EXISTS')
		const name = upperWord(rest[at]) === 'ON' ? undefined : objectNameAt(rest, at)?.name
		at = name === undefined ? at : (afterName(rest, at) ?? at)
		if (upperWord(rest[at]) !== 'ON') return
		at = skipWords(rest, at + 1, 'ONLY')
		const table = objectNameAt(rest, at)?.name
		const after = afterName(rest, at)
		if (table === undefined || after === undefined) return
		const list = columnList(rest, upperWord(rest[after]) === 'USING' ? after + 2 : after)
		const columns = list?.columns.filter((column) => column !== undefined) ?? []
		if (list === undefined || columns.length !== list.columns.length || depthZeroWords(rest.slice(list.end)).includes('WHERE')) return
		unique.push({ name, table, columns })
	} else if (verb === 'DROP' && object === 'INDEX') {
		const at = skipWords(tokens, skipWords(tokens, 2, 'CONCURRENTLY'), 'IF', 'EXISTS')
		const dropped = new Set(splitAtCommas(tokens.slice(at)).map((part) => objectNameAt(part, 0)?.name))
		const kept = unique.filter((index) => index.name === undefined || !dropped.has(index.name))
		unique.splice(0, unique.length, ...kept)
	}
}

/**
 * One action of `ALTER TABLE table`: `ADD` a unique column or constraint, `DROP CONSTRAINT` one by name, `DROP COLUMN`,
 * or `RENAME` the table or a column, which the unique keys follow.
 */
function alterUnique(table: string, action: readonly SqlToken[], unique: UniqueIndex[], keep: (kept: (index: UniqueIndex) => boolean) => void): void {
	const verb = upperWord(action[0])
	if (verb === 'ADD') {
		readUniqueElement(table, action.slice(skipWords(action, skipWords(action, 1, 'COLUMN'), 'IF', 'NOT', 'EXISTS')), unique)
	} else if (verb === 'DROP' && upperWord(action[1]) === 'CONSTRAINT') {
		const name = objectNameAt(action, skipWords(action, 2, 'IF', 'EXISTS'))?.name
		keep((index) => index.table !== table || index.name !== name)
	} else if (verb === 'DROP') {
		const column = objectNameAt(action, skipWords(action, skipWords(action, 1, 'COLUMN'), 'IF', 'EXISTS'))?.name
		keep((index) => index.table !== table || column === undefined || !index.columns.includes(column))
	} else if (verb === 'RENAME' && upperWord(action[1]) === 'TO') {
		const to = objectNameAt(action, 2)?.name
		if (to !== undefined) unique.splice(0, unique.length, ...unique.map((index) => (index.table === table ? { ...index, table: to } : index)))
	} else if (verb === 'RENAME') {
		const at = skipWords(action, 1, 'COLUMN')
		const from = objectNameAt(action, at)?.name
		const after = afterName(action, at)
		const to = after === undefined || upperWord(action[after]) !== 'TO' ? undefined : objectNameAt(action, after + 1)?.name
		if (from === undefined || to === undefined) return
		unique.splice(
			0,
			unique.length,
			...unique.map((index) => index.table === table ? { ...index, columns: index.columns.map((column) => (column === from ? to : column)) } : index),
		)
	}
}

/**
 * A column with `UNIQUE` or `PRIMARY KEY`, or a `UNIQUE (…)` or `PRIMARY KEY (…)` table constraint, named as declared or
 * as Postgres names it by default (`<table>_pkey`, `<table>_<columns>_key`), so a later `DROP CONSTRAINT` finds it.
 */
function readUniqueElement(table: string, element: readonly SqlToken[], unique: UniqueIndex[]): void {
	const head = upperWord(element[0])
	if (head !== undefined && TABLE_CONSTRAINTS.has(head)) {
		const constraint = head === 'CONSTRAINT' ? element.slice(2) : element
		const kind = upperWord(constraint[0])
		const open = kind === 'PRIMARY' ? 2 : kind === 'UNIQUE' ? afterNullsClause(constraint) : undefined
		const list = open === undefined ? undefined : columnList(constraint, open)
		const columns = list?.columns.filter((column) => column !== undefined) ?? []
		if (list !== undefined && columns.length > 0 && columns.length === list.columns.length) {
			const declared = head === 'CONSTRAINT' ? nameText(element[1]) : undefined
			unique.push({ name: declared ?? defaultConstraintName(table, kind === 'PRIMARY', columns), table, columns })
		}
		return
	}
	const column = nameText(element[0])
	const words = depthZeroWords(element.slice(1))
	if (column !== undefined && words.some((word) => word === 'UNIQUE' || word === 'PRIMARY')) {
		const named = element.findIndex((token) => upperWord(token) === 'CONSTRAINT')
		const declared = named < 0 ? undefined : nameText(element[named + 1])
		unique.push({ name: declared ?? defaultConstraintName(table, words.includes('PRIMARY'), [column]), table, columns: [column] })
	}
}
