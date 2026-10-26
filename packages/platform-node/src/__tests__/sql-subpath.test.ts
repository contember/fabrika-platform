import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import packageJson from '../../package.json'

const SOURCE = join(import.meta.dir, '..')
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/g

/** Every module specifier the file at `path` and the files it reaches import, keyed by importing file. */
function importGraph(path: string, seen: Map<string, string[]> = new Map()): Map<string, string[]> {
	if (seen.has(path)) return seen
	const specifiers = [...readFileSync(path, 'utf8').matchAll(IMPORT)].map((match) => match[1] ?? '')
	seen.set(path, specifiers)
	for (const specifier of specifiers) {
		if (specifier.startsWith('./')) importGraph(join(dirname(path), `${specifier.slice(2)}.ts`), seen)
	}
	return seen
}

describe('@fabrika/platform-node/sql', () => {
	test('is exported and reaches no module outside its own relative files, so a Worker loads it', () => {
		expect(packageJson.exports['./sql'].default).toBe('./src/sql.ts')
		const graph = importGraph(join(SOURCE, 'sql.ts'))
		const external = [...graph].flatMap(([file, specifiers]) =>
			specifiers.filter((specifier) => !specifier.startsWith('./')).map((specifier) => `${file}: ${specifier}`)
		)
		expect(external).toEqual([])
		expect([...graph.keys()].map((file) => file.slice(SOURCE.length + 1)).sort()).toEqual([
			'application-schema.ts',
			'file-table-ddl.ts',
			'migration-classify.ts',
			'migration-sql.ts',
			'pg-catalog-names.ts',
			'postgres-migration-error.ts',
			'sql-names.ts',
			'sql.ts',
			'sqlite-sql.ts',
		])
	})

	test('classifies a migration through the subpath', async () => {
		const sql = await import('@fabrika/platform-node/sql')
		const result = sql.classifyMigration('CREATE VIEW v AS SELECT 1', 'app_notes', { file: 'a.sql' })
		expect(result.deviations).toEqual([{ kind: 'view', object: 'v', file: 'a.sql', line: 1 }])
	})
})
