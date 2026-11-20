// The dialect an application's data layer runs on, read from its `fabrika.config.ts`: SQLite on Cloudflare (ADR-0065),
// Postgres otherwise.

import { describe, expect, test } from 'bun:test'
import { applicationDialect } from '../dialect'

const dialectOf = (config: string | undefined): string => applicationDialect(new Map(config === undefined ? [] : [['fabrika.config.ts', config]]))

describe('applicationDialect', () => {
	test("SQLite for a default export of @fabrika/provider-cloudflare's defineApp, under any local name", () => {
		expect(dialectOf("import { defineApp } from '@fabrika/provider-cloudflare'\nexport default defineApp({ id: 'notes' })\n")).toBe('sqlite')
		expect(dialectOf("import { defineApp as app } from '@fabrika/provider-cloudflare'\nexport default app({ id: 'notes' }) satisfies object\n")).toBe(
			'sqlite',
		)
	})

	test('Postgres for a Zerops config, no config, a config that does not parse, and a call of another defineApp', () => {
		expect(dialectOf("import { defineApp } from '@fabrika/provider-zerops'\nexport default defineApp({ id: 'notes' })\n")).toBe('postgres')
		expect(dialectOf(undefined)).toBe('postgres')
		expect(dialectOf('export default {')).toBe('postgres')
		expect(dialectOf("import { defineApp } from './local'\nexport default defineApp({ id: 'notes' })\n")).toBe('postgres')
		expect(dialectOf("import { Worker } from '@fabrika/provider-cloudflare'\nexport default new Worker({})\n")).toBe('postgres')
	})
})
