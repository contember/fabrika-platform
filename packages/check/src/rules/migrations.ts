import {
	afterName,
	closingParenthesis,
	fileTableScanReady,
	isPunct,
	nameText,
	objectNameAt,
	skipWords,
	splitAtCommas,
	type SqlToken,
	topLevelStatements,
	upperWord,
} from '@fabrika/platform-node/sql'
import type { Finding } from '../finding'
import { MIGRATIONS_DIR } from '../layout'

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

/**
 * A `scan: true` collection whose table no migration lets hold the scan states — the earlier `fileTableSql` DDL, which
 * admits only `pending` and `live`, without `fileScanSql` after it — would fail every upload at its `quarantined`
 * row. Only the named check of every state with the scan columns, or the exact `fileScanSql` statement, counts
 * (`fileTableScanReady`). A collection whose table no migration creates is not this rule's.
 */
export const checkScanMigrations = (
	files: ReadonlyMap<string, string>,
	scanning: readonly string[],
): Finding[] => {
	const migrations = [...files.entries()]
		.filter(
			([path]) => path.startsWith(MIGRATIONS_DIR) && path.endsWith('.sql'),
		)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	const findings: Finding[] = []
	for (const name of scanning) {
		const table = `fabrika_files_${name}`
		if (
			fileTableScanReady(
				migrations.map(([, sql]) => sql),
				table,
			) !== false
		) {
			continue
		}
		const creating = migrations.find(
			([, sql]) => fileTableScanReady([sql], table) !== undefined,
		)
		const path = creating?.[0] ?? MIGRATIONS_DIR
		const line = creating === undefined ? 1 : lineOf(creating[1], table)
		findings.push({
			file: path,
			line,
			column: 1,
			severity: 'refusal',
			rule: 'file-scan-migration',
			message: `files '${name}' sets scan: true, and no migration lets ${table} hold a quarantined file`,
			allowed:
				`a new migration holding fileScanSql('${name}') of @fabrika/db, exactly as it writes it: ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS …, ADD CONSTRAINT ${table}_status CHECK (…), ADD COLUMN object_version TEXT, …`,
		})
	}
	return findings
}

/** The line of the `CREATE TABLE` of `table` in `sql`. */
function lineOf(sql: string, table: string): number {
	const match = new RegExp(
		`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${table}\\b`,
		'i',
	).exec(sql)
	return match === null ? 1 : sql.slice(0, match.index).split('\n').length
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
