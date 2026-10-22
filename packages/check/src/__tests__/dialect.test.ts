// The dialect an application's data layer runs on, read from its `fabrika.config.ts`, and the test database kit the
// scaffold's tests import for it: the SQLite kit on Cloudflare (ADR-0065), the Postgres kit otherwise.

import { describe, expect, test } from 'bun:test'
import { applicationDialect } from '../dialect'
import { generatedTests, scaffoldInputs } from '../scaffold'
import { CLEAN_APPLICATION } from './helpers'

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

describe('the generated tests open the test database of the dialect', () => {
	const generatedFor = async (config: string | undefined): Promise<string[]> => {
		const files = new Map(Object.entries(CLEAN_APPLICATION))
		if (config !== undefined) files.set('fabrika.config.ts', config)
		const inputs = scaffoldInputs(files)
		return [...(await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures, inputs.dialect)).values()].map((item) => item.text)
	}

	test('the SQLite kit on Cloudflare', async () => {
		const texts = await generatedFor("import { defineApp } from '@fabrika/provider-cloudflare'\nexport default defineApp({ id: 'notes' })\n")
		expect(texts.length).toBeGreaterThan(1)
		for (const text of texts) {
			expect(text).toContain("import { testDatabase } from '@fabrika/db/testing-sqlite'\n")
			expect(text).not.toContain("from '@fabrika/db/testing'\n")
			expect(text).toContain('if (database !== null) {')
		}
	})

	test('the Postgres kit on Zerops, and what the scaffold wrote before for an application without a config', async () => {
		const zerops = await generatedFor("import { defineApp } from '@fabrika/provider-zerops'\nexport default defineApp({ id: 'notes' })\n")
		const unconfigured = await generatedFor(undefined)
		expect(zerops).toEqual(unconfigured)
		for (const text of zerops) {
			expect(text).toContain("import { testDatabase } from '@fabrika/db/testing'\n")
			expect(text).toContain('if (postgres !== null) {')
		}
	})
})
