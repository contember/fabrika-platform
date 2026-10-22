// What a dev sync's paths mean: which change needs a bootstrap run, and which migrates or rebuilds the SPA.

import { describe, expect, test } from 'bun:test'
import { bootstrapReason, migrationsChanged, webSourceChanged } from '../dev/changes.js'

describe('a dev sync', () => {
	test('applies a change of application code, the contract file and the migrations: the digest decides the contract', () => {
		expect(bootstrapReason(['src/app.ts', 'src/notes/endpoints.ts', 'fabrika.contract.ts', 'web/main.tsx', 'db/migrations/1_a.sql'])).toBeNull()
	})

	test('needs a bootstrap for what the build owns, naming the path', () => {
		for (const path of ['package.json', 'bun.lock', 'zerops.yaml', 'fabrika/entry.generated.ts', 'node_modules/x/index.js', 'fabrika.config.ts']) {
			expect(bootstrapReason([path])).toStartWith(`${path} changed`)
		}
	})

	test('migrates when db/migrations changed, and builds the SPA when a change lies outside src/ and db/', () => {
		expect(migrationsChanged(['db/migrations/20260101000000_a.sql'])).toBe(true)
		expect(migrationsChanged(['src/db/tables.ts'])).toBe(false)
		expect(webSourceChanged(['src/notes/handler.ts', 'db/migrations/x.sql'])).toBe(false)
		expect(webSourceChanged(['web/main.tsx'])).toBe(true)
	})
})
