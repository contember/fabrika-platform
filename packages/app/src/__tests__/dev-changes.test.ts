// What a dev sync's paths mean: which change needs a bootstrap run, and which migrates or rebuilds the SPA.

import { describe, expect, test } from 'bun:test'
import { bootstrapReason, contractModules, migrationsChanged, webSourceChanged } from '../dev/changes.js'

const tree = (files: Record<string, string>) => (path: string): string | null => files[path] ?? null

const before = tree({
	'fabrika.contract.ts': "import { app } from './src/app-kit'\nexport * from './src/notes/endpoints.js'\n",
	'src/app-kit.ts': "import { tables } from './db/tables'\nimport { vocabulary } from './vocabulary'\n",
	'src/db/tables.ts': 'export const tables = {}\n',
	'src/vocabulary.ts': 'export const vocabulary = {}\n',
	'src/notes/endpoints.ts': "import { app } from '../app-kit'\nexport const handle = await import('./handler')\n",
	'src/notes/handler.ts': 'export const x = 1\n',
	'src/app.ts': "import { contract } from '../fabrika.contract'\n",
})

describe('a dev sync', () => {
	test('reads the contract and every module it reaches by a relative import', () => {
		expect([...contractModules(before)].sort()).toEqual([
			'fabrika.contract.ts',
			'src/app-kit.ts',
			'src/db/tables.ts',
			'src/notes/endpoints.ts',
			'src/notes/handler.ts',
			'src/vocabulary.ts',
		])
	})

	test('applies a change of application code the contract does not import', () => {
		expect(bootstrapReason(['src/app.ts', 'web/main.tsx', 'db/migrations/20260101000000_a.sql'], before, before)).toBeNull()
	})

	test('needs a bootstrap for what the build owns, naming the path', () => {
		for (const path of ['package.json', 'bun.lock', 'zerops.yaml', 'fabrika/entry.generated.ts', 'node_modules/x/index.js', 'fabrika.config.ts']) {
			expect(bootstrapReason([path], before, before)).toStartWith(`${path} changed`)
		}
		expect(bootstrapReason(['src/vocabulary.ts'], before, before)).toContain('the contract or a module it imports')
	})

	test('counts a module the contract imports only at the target', () => {
		const after = tree({ 'src/new.ts': 'export const y = 2\n', 'fabrika.contract.ts': "import { y } from './src/new'\n" })
		expect(bootstrapReason(['src/new.ts'], before, after)).toContain('src/new.ts changed')
	})

	test('migrates when db/migrations changed, and builds the SPA when a change lies outside src/ and db/', () => {
		expect(migrationsChanged(['db/migrations/20260101000000_a.sql'])).toBe(true)
		expect(migrationsChanged(['src/db/tables.ts'])).toBe(false)
		expect(webSourceChanged(['src/notes/handler.ts', 'db/migrations/x.sql'])).toBe(false)
		expect(webSourceChanged(['web/main.tsx'])).toBe(true)
	})
})
