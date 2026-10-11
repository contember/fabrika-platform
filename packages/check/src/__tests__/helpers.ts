import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkApplication } from '../check'
import type { Finding, RuleId } from '../finding'
import { generatedTests, scaffoldInputs } from '../scaffold'

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

/** The contract's vocabulary as \`src/vocabulary.ts\` declares it, which \`defineTables\` takes. */
export const CLEAN_VOCABULARY = `import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
})
`

export const CLEAN_TABLES = `import { defineTables } from '@fabrika/db'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note' },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.write' },
		insert: ['title'],
	},
})
`

/** What \`fabrika db codegen\` writes: the schema types and the column list \`defineTables\` checks policies against. */
export const CLEAN_SCHEMA_GENERATED = `import type { TypedColumnList } from '@fabrika/db'

export interface DB {
	notes: { id: string; workspace_id: string; title: string }
}

export const columns: TypedColumnList<DB> = { notes: ['id', 'workspace_id', 'title'] }
`

const CLEAN_SOURCES = new Map([
	['fabrika.contract.ts', CLEAN_CONTRACT],
	['src/schemas/notes.ts', CLEAN_SCHEMAS],
	['src/vocabulary.ts', CLEAN_VOCABULARY],
	['src/db/tables.ts', CLEAN_TABLES],
	['src/db/schema.generated.ts', CLEAN_SCHEMA_GENERATED],
])

const cleanInputs = scaffoldInputs(CLEAN_SOURCES)

/** What `fabrika db test-scaffold` writes for the clean application, by path. */
export const CLEAN_GENERATED_TESTS: ReadonlyMap<string, string> = new Map(
	[...(await generatedTests(cleanInputs.policies, cleanInputs.artifact))].map(([path, test]) => [path, test.text]),
)

export const CLEAN_APPLICATION: Readonly<Record<string, string>> = {
	...Object.fromEntries(CLEAN_SOURCES),
	...Object.fromEntries(CLEAN_GENERATED_TESTS),
}
