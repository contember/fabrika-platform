import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkApplication } from '../check'
import { readTablesSource } from '../contract'
import type { Finding, RuleId } from '../finding'
import { isolationTests } from '../scaffold'

export const check = (files: Readonly<Record<string, string>>): Promise<Finding[]> =>
	checkApplication({ root: '/application', files: new Map(Object.entries(files)) })

export const locations = (findings: readonly Finding[], rule: RuleId): string[] =>
	findings.filter((finding) => finding.rule === rule).map((finding) => `${finding.file}:${finding.line}:${finding.column}`)

/** A file of the clean application; `differential.test.ts` also imports it as a module. */
function readFixture(path: string): string {
	return readFileSync(join(import.meta.dir, 'fixtures', 'clean-app', path), 'utf8')
}

/** A contract that every rule accepts, with one job, for the rules that read the contract. */
export const CLEAN_CONTRACT = readFixture('fabrika.contract.ts')

export const CLEAN_SCHEMAS = readFixture('src/schemas/notes.ts')

export const CLEAN_TABLES = `import { defineTables } from '@fabrika/db'
import { columns, type DB } from './schema.generated'

export const tables = defineTables<DB, 'notes.read' | 'notes.write'>(columns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.write' },
		insert: ['title'],
	},
})
`

/** What \`fabrika db codegen\` writes: the schema types and the column list \`defineTables\` checks policies against. */
export const CLEAN_SCHEMA_GENERATED = `import type { ColumnList } from '@fabrika/db'

export interface DB {
	notes: { id: string; workspace_id: string; title: string }
}

export const columns = { notes: ['id', 'workspace_id', 'title'] } as const satisfies ColumnList<DB>
`

const CLEAN_TABLE_FILES = new Map([
	['src/db/tables.ts', CLEAN_TABLES],
	['src/db/schema.generated.ts', CLEAN_SCHEMA_GENERATED],
])

/** What `fabrika db test-scaffold` writes for the clean tables: the isolation test of `notes`. */
export const CLEAN_ISOLATION_TESTS: ReadonlyMap<string, string> = await isolationTests(readTablesSource(CLEAN_TABLE_FILES))

export const CLEAN_APPLICATION: Readonly<Record<string, string>> = {
	'fabrika.contract.ts': CLEAN_CONTRACT,
	'src/schemas/notes.ts': CLEAN_SCHEMAS,
	...Object.fromEntries(CLEAN_TABLE_FILES),
	...Object.fromEntries(CLEAN_ISOLATION_TESTS),
}
