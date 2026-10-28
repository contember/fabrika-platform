// The dialect an application's data layer runs on, read from its `fabrika.config.ts`, and the test database kit the
// scaffold's tests import for it: the SQLite kit on Cloudflare (ADR-0065), the Postgres kit otherwise.

import { describe, expect, test } from 'bun:test'
import { applicationDialect, type ApplicationTarget, applicationTarget } from '../dialect'
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

describe('applicationTarget', () => {
	const targetOf = (config: string | undefined) => applicationTarget(new Map(config === undefined ? [] : [['fabrika.config.ts', config]]))
	const cloudflare = (argument: string): string => `import { defineApp } from '@fabrika/provider-cloudflare'\nexport default defineApp(${argument})\n`

	test('Postgres and not Cloudflare for a Zerops config, no config and a config that does not parse', () => {
		expect(targetOf("import { defineApp } from '@fabrika/provider-zerops'\nexport default defineApp({ id: 'notes' })\n")).toEqual({
			cloudflare: false,
			dialect: 'postgres',
		})
		expect(targetOf(undefined)).toEqual({ cloudflare: false, dialect: 'postgres' })
		expect(targetOf('export default {')).toEqual({ cloudflare: false, dialect: 'postgres' })
	})

	test('SQLite for a Cloudflare config that names no database, or one the read sees none of', () => {
		expect(targetOf(cloudflare("{ id: 'notes' }"))).toEqual({ cloudflare: true, dialect: 'sqlite' })
		expect(targetOf(cloudflare("{ id: 'notes', worker: { compatibility_date: '2025-10-01' } }"))).toEqual({ cloudflare: true, dialect: 'sqlite' })
		expect(targetOf("import { defineApp } from '@fabrika/provider-cloudflare'\nconst config = { id: 'notes' }\nexport default defineApp(config)\n"))
			.toEqual({
				cloudflare: true,
				dialect: 'sqlite',
			})
	})

	test("Postgres for a Cloudflare config that states database: { kind: 'postgres', … } inline", () => {
		const postgres: ApplicationTarget = { cloudflare: true, dialect: 'postgres' }
		expect(targetOf(cloudflare("{ id: 'notes', database: { kind: 'postgres', provisioningSecret: 'DATABASE_URL' } }"))).toEqual(postgres)
		expect(targetOf(cloudflare("{ id: 'notes', 'database': { kind: `postgres`, provisioningSecret: 'X' } } satisfies object"))).toEqual(postgres)
		expect(targetOf(cloudflare("{ id: 'notes', database: { kind: 'postgres' as const, provisioningSecret: 'X' } }"))).toEqual(postgres)
		expect(applicationDialect(new Map([['fabrika.config.ts', cloudflare("{ id: 'notes', database: { kind: 'postgres', provisioningSecret: 'X' } }")]])))
			.toBe('postgres')
	})

	test('unreadable for a Cloudflare database the static read cannot settle, which reads as SQLite', () => {
		const unreadable = (argument: string, preamble = ''): string | undefined => {
			const target = targetOf(`import { defineApp } from '@fabrika/provider-cloudflare'\n${preamble}export default defineApp(${argument})\n`)
			expect(target.cloudflare).toBe(true)
			expect(target.dialect).toBe('sqlite')
			return target.unreadable
		}
		expect(unreadable("{ id: 'notes', database: { ...base, provisioningSecret: 'X' } }", "const base = { kind: 'postgres' } as const\n")).toContain(
			'spreads',
		)
		expect(unreadable("{ id: 'notes', database: { kind: 'mysql', provisioningSecret: 'X' } }")).toContain("other than the literal 'postgres'")
		expect(unreadable("{ id: 'notes', database: { kind: KIND, provisioningSecret: 'X' } }", "let KIND = 'postgres'\n")).toContain(
			"other than the literal 'postgres'",
		)
		expect(unreadable("{ id: 'notes', database: postgres }", "let postgres = { kind: 'postgres', provisioningSecret: 'X' }\n")).toContain(
			'not an object literal',
		)
		expect(unreadable("{ id: 'notes', get database() { return { kind: 'postgres', provisioningSecret: 'X' } } }")).toContain('not an object literal')
		expect(unreadable("{ id: 'notes', database: { kind: 'mysql' } }")).toContain(
			"write it as `export default defineApp({ …, database: { kind: 'postgres', provisioningSecret: '<SECRET>' } })`",
		)
		expect(unreadable("{ id: 'notes', database: { provisioningSecret: 'X' } }")).toContain('names no `kind`')
		expect(unreadable("{ id: 'notes', database: { kind: 'postgres', provisioningSecret: 'X' }, database: undefined }")).toContain(
			'not an object literal',
		)
	})
})

describe('applicationTarget follows the shapes TypeScript accepts', () => {
	const targetOf = (config: string) => applicationTarget(new Map([['fabrika.config.ts', config]]))
	const IMPORT = "import { defineApp } from '@fabrika/provider-cloudflare'\n"
	const DATABASE = "database: { kind: 'postgres', provisioningSecret: 'DATABASE_URL' }"
	const postgres: ApplicationTarget = { cloudflare: true, dialect: 'postgres' }

	test('a default export through a const binding, and a namespace call', () => {
		expect(targetOf(`${IMPORT}const app = defineApp({ id: 'notes', ${DATABASE} })\nexport default app\n`)).toEqual(postgres)
		expect(targetOf(`${IMPORT}const app = defineApp({ id: 'notes', ${DATABASE} })\nexport { app as default }\n`)).toEqual(postgres)
		expect(targetOf(`import * as cf from '@fabrika/provider-cloudflare'\nexport default cf.defineApp({ id: 'notes', ${DATABASE} })\n`)).toEqual(
			postgres,
		)
		expect(targetOf(`${IMPORT}const app = defineApp({ id: 'notes' })\nexport default app\n`)).toEqual({ cloudflare: true, dialect: 'sqlite' })
		expect(targetOf("import * as zerops from '@fabrika/provider-zerops'\nexport default zerops.defineApp({ id: 'notes' })\n")).toEqual({
			cloudflare: false,
			dialect: 'postgres',
		})
	})

	test('an argument, a spread and a database value through const bindings', () => {
		expect(targetOf(`${IMPORT}const settings = { id: 'notes', ${DATABASE} } as const\nexport default defineApp(settings)\n`)).toEqual(postgres)
		expect(targetOf(`${IMPORT}const base = { ${DATABASE} }\nexport default defineApp({ id: 'notes', ...base })\n`)).toEqual(postgres)
		expect(
			targetOf(
				`${IMPORT}const database = { kind: 'postgres', provisioningSecret: 'X' } as const\nexport default defineApp({ id: 'notes', database })\n`,
			),
		)
			.toEqual(postgres)
		expect(targetOf(`${IMPORT}const KIND = 'postgres'\nexport default defineApp({ id: 'notes', database: { kind: KIND, provisioningSecret: 'X' } })\n`))
			.toEqual(postgres)
		// A spread after `database` that names none leaves it; one that names it wins, as at runtime.
		expect(targetOf(`${IMPORT}const extra = { id: 'notes' }\nexport default defineApp({ ${DATABASE}, ...extra })\n`)).toEqual(postgres)
		expect(
			targetOf(
				`${IMPORT}const extra = { database: { kind: 'postgres', provisioningSecret: 'X' } }\nexport default defineApp({ id: 'notes', ...extra })\n`,
			),
		)
			.toEqual(postgres)
	})

	test('unsettled, and SQLite, for an argument or a spread the read cannot follow; a later database settles it', () => {
		expect(targetOf(`${IMPORT}export default defineApp(load())\n`)).toEqual({
			cloudflare: true,
			dialect: 'sqlite',
			unsettled: 'its argument is no object literal the read can follow',
		})
		expect(targetOf(`${IMPORT}let settings = { id: 'notes', ${DATABASE} }\nexport default defineApp(settings)\n`).unsettled).toBe(
			'its argument is no object literal the read can follow',
		)
		expect(targetOf(`${IMPORT}export default defineApp({ id: 'notes', ...load() })\n`)).toEqual({
			cloudflare: true,
			dialect: 'sqlite',
			unsettled: 'it spreads a value the read cannot follow',
		})
		expect(targetOf(`${IMPORT}export default defineApp({ ${DATABASE}, ...load() })\n`).unsettled).toBe('it spreads a value the read cannot follow')
		expect(targetOf(`${IMPORT}export default defineApp({ ...load(), ${DATABASE} })\n`)).toEqual(postgres)
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
