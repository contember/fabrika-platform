// The application architecture (docs/reference/application-architecture.md) as the checker reports it: a step out of
// the structure is a hint, which never fails the check; a break of platform integrity is a refusal.

import { afterEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { STRUCTURE_RULE_IDS } from '../rules/structure'
import { check, CLEAN_APPLICATION } from './helpers'

const FIXTURE = join(import.meta.dir, 'fixtures', 'architecture-app')
const CLI = join(import.meta.dir, '..', 'cli.ts')

/** The fixture's files by path; a `.fixture` suffix keeps a source file out of this repository's own typecheck. */
const readFixture = (root: string): Readonly<Record<string, string>> => {
	const files: Record<string, string> = {}
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue
		const path = join(entry.parentPath, entry.name)
		files[relative(root, path).replace(/\.fixture$/, '')] = readFileSync(path, 'utf8')
	}
	return files
}

const ARCHITECTURE_APP = readFixture(FIXTURE)

const fileOf = (path: string): string => {
	const text = ARCHITECTURE_APP[path]
	if (text === undefined) throw new Error(`the architecture fixture has no ${path}`)
	return text
}

const withImport = (path: string, line: string): string => `${line}\n${fileOf(path)}`

/** The findings of the architecture's rules, as `file:line:column severity rule`. */
const structureFindings = async (files: Readonly<Record<string, string>>): Promise<string[]> =>
	(await check(files))
		.filter((finding) => STRUCTURE_RULE_IDS.some((rule) => rule === finding.rule))
		.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.severity} ${finding.rule}`)

describe('the clean layout', () => {
	test('a two-slice application in the architecture reports nothing', async () => {
		expect(await structureFindings(ARCHITECTURE_APP)).toEqual([])
	})
})

describe('a step out of the structure is a hint', () => {
	test('logic that reaches data', async () => {
		const findings = await structureFindings({
			...ARCHITECTURE_APP,
			'src/deals/logic.ts': "import { fromRow } from '@fabrika/db'\n"
				+ "import { lockedStage } from './queries'\n"
				+ "import { columns } from '../db/schema.generated'\n"
				+ "import type { DB } from '../db/schema.generated'\n"
				+ "import { Deal } from '../schemas'\n\n"
				+ 'export const load = async ({ ctx }) => fromRow(Deal, await ctx.db.target.get())\n'
				+ 'export const rows = async ({ ctx }) => ctx.sql(Deal)`select * from deals`\n'
				+ "export const known = (row: DB['deals']) => [lockedStage, columns, row]\n",
		})
		expect(findings).toEqual([
			'src/deals/logic.ts:1:1 hint logic-data-access',
			'src/deals/logic.ts:2:1 hint logic-data-access',
			'src/deals/logic.ts:3:1 hint logic-data-access',
			'src/deals/logic.ts:7:60 hint logic-data-access',
			'src/deals/logic.ts:8:40 hint logic-data-access',
		])
	})

	test("a slice that imports another slice's queries", async () => {
		const findings = await structureFindings({
			...ARCHITECTURE_APP,
			'src/companies/endpoints.ts': withImport('src/companies/endpoints.ts', "import { lockedStage } from '../deals/queries'"),
			// A type, a slice's own queries and another slice's logic are not data access across slices.
			'src/companies/queries.ts': withImport(
				'src/companies/queries.ts',
				"import type { lockedStage } from '../deals/queries'\nimport { canReopen } from '../deals/logic'",
			),
		})
		expect(findings).toEqual(['src/companies/endpoints.ts:1:1 hint cross-slice-queries'])
	})

	test("a handler outside a slice's endpoints.ts", async () => {
		const findings = await structureFindings({
			...ARCHITECTURE_APP,
			'src/deals/reports.ts': "import { app } from '../app-kit'\n"
				+ "import { OrgInput, Pipeline } from '../schemas'\n\n"
				+ "export const reports = app.group({ callers: ['human'] }, (r) => ({\n"
				+ "\tpipeline: r.query({ input: OrgInput, output: Pipeline, access: { action: 'crm.read', in: 'org', from: 'orgId' } })\n"
				+ '\t\t.handle(async () => ({ rows: [] })),\n'
				+ '}))\n',
			'fabrika.contract.ts': fileOf('fabrika.contract.ts').replace(
				"health: c.health('/healthz'),",
				"health: c.health('/healthz'),\n\tjobs: { purge: c.cron('0 3 * * *', { actions: ['deals.write'], scope: 'app' }).handle(async () => {}) },",
			),
		})
		expect(findings).toEqual([
			'fabrika.contract.ts:9:81 hint handler-location',
			'src/deals/reports.ts:6:4 hint handler-location',
		])
	})

	test('data access outside endpoints.ts and queries.ts', async () => {
		const findings = await structureFindings({
			...ARCHITECTURE_APP,
			'src/deals/format.ts': 'export const titles = async ({ ctx }) => (await ctx.db.within.deals.list()).map((deal) => deal.title)\n'
				+ 'export const count = async ({ ctx }) => ctx.sql(Count)`select count(*) from deals`\n',
			// A test reaches data as it likes.
			'src/deals/format.test.ts': "import { expect, test } from 'bun:test'\n\n"
				+ "test('lists', async () => expect(await ctx.db.within.deals.list()).toEqual([]))\n",
		})
		expect(findings).toEqual([
			'src/deals/format.ts:1:49 hint data-access-location',
			'src/deals/format.ts:2:41 hint data-access-location',
		])
	})
})

describe('a break of platform integrity is a refusal', () => {
	test('the SPA imports no server module', async () => {
		const findings = await structureFindings({
			...ARCHITECTURE_APP,
			'web/main.ts': withImport(
				'web/main.ts',
				"import { lockedStage } from '../src/deals/queries'\n"
					+ "import { scoped } from '@fabrika/db'\n"
					+ "import { ConflictError } from '@fabrika/app'\n"
					+ "import { serve } from 'bun'\n"
					+ "import { app } from '../src/app-kit'\n"
					+ "import type { canReopen } from '../src/deals/logic'\n"
					+ "import { z } from 'zod/v4'",
			),
			// A test of the SPA is not bundled into it.
			'web/__tests__/main.test.ts': "import { expect, test } from 'bun:test'\nimport { tables } from '../../src/db/tables'\n\n"
				+ "test('tables', () => expect(tables).toBeDefined())\n",
		})
		expect(findings).toEqual([
			'web/main.ts:1:1 refusal spa-server-import',
			'web/main.ts:2:1 refusal spa-server-import',
			'web/main.ts:3:1 refusal spa-server-import',
			'web/main.ts:4:1 refusal spa-server-import',
			'web/main.ts:5:1 refusal spa-server-import',
		])
	})

	test('logic and queries import no framework internal', async () => {
		const findings = await structureFindings({
			...ARCHITECTURE_APP,
			'src/deals/logic.ts': withImport('src/deals/logic.ts', "import { describeContract } from '@fabrika/app/contract'"),
			'src/deals/queries.ts': withImport(
				'src/deals/queries.ts',
				"import { generateSchema } from '@fabrika/db/codegen'\nimport { ConflictError } from '@fabrika/app'\nimport type { Ref } from '@fabrika/db/capability'",
			),
			// An endpoints module composes the framework; the layer rule is for logic and queries.
			'src/deals/endpoints.ts': withImport('src/deals/endpoints.ts', "import { compileContract } from '@fabrika/app/contract'"),
		})
		expect(findings).toEqual([
			'src/deals/logic.ts:1:1 refusal layer-import',
			'src/deals/queries.ts:1:1 refusal layer-import',
		])
	})

	test('nothing imports a generated test', async () => {
		const findings = await structureFindings({
			...ARCHITECTURE_APP,
			'src/__tests__/endpoint-access.test.ts': '// @generated by fabrika db test-scaffold sha256:00\nexport const cases = []\n',
			'src/db/__tests__/deals.policy-isolation.test.ts': '// @generated by fabrika db test-scaffold sha256:00\nexport const cases = []\n',
			'src/deals/logic.test.ts': withImport('src/deals/logic.test.ts', "import { cases } from '../__tests__/endpoint-access.test'"),
			'src/deals/fixtures.ts': "export type { cases } from '../db/__tests__/deals.policy-isolation.test.ts'\n",
		})
		expect(findings).toEqual([
			'src/deals/fixtures.ts:1:1 refusal generated-test-import',
			'src/deals/logic.test.ts:1:1 refusal generated-test-import',
		])
	})
})

describe('a refusal follows the import as Bun resolves it', () => {
	/** The refusals among the findings, as `file:line:column rule`. */
	const refusals = async (files: Readonly<Record<string, string>>, rules: readonly string[]): Promise<string[]> =>
		(await check(files))
			.filter((finding) => finding.severity === 'refusal' && rules.includes(finding.rule))
			.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule}`)

	const GENERATED = '// @generated by fabrika db test-scaffold sha256:00\nexport const cases = []\n'

	test("through the importing module's own package scope", async () => {
		expect(
			await refusals({
				...ARCHITECTURE_APP,
				'src/__tests__/package.json': '{ "imports": { "#generated": "./endpoint-access.test.ts" } }\n',
				'src/__tests__/endpoint-access.test.ts': GENERATED,
				'src/__tests__/authored.test.ts': "import { cases } from '#generated'\n",
				'src/deals/package.json': '{ "imports": { "#kit": "@fabrika/app/testing" } }\n',
				'src/deals/queries.ts': withImport('src/deals/queries.ts', "import { testKit } from '#kit'"),
			}, ['generated-test-import', 'test-only-import']),
		).toEqual([
			'src/__tests__/authored.test.ts:1:1 generated-test-import',
			'src/deals/queries.ts:1:1 test-only-import',
		])
	})

	test('through the nearest tsconfig.json, its extends and targets relative to the file that declares them', async () => {
		const inherited = {
			...ARCHITECTURE_APP,
			'tsconfig.base.json': '{ "compilerOptions": { "paths": { "~server": ["./src/db/tables.ts"] } } }\n',
			'web/tsconfig.json': '{ "extends": "../tsconfig.base.json" }\n',
			'web/main.ts': withImport('web/main.ts', "import { tables } from '~server'"),
		}
		expect(await refusals(inherited, ['spa-server-import'])).toEqual(['web/main.ts:1:1 spa-server-import'])

		const nested = {
			...ARCHITECTURE_APP,
			'web/tsconfig.json': '{ "compilerOptions": { "paths": { "@db": ["../src/db/tables.ts"] } } }\n',
			'web/main.ts': withImport('web/main.ts', "import { tables } from '@db'"),
		}
		expect(await refusals(nested, ['spa-server-import'])).toEqual(['web/main.ts:1:1 spa-server-import'])

		// A nearer tsconfig.json without the mapping hides the root's: Bun no longer resolves '~server' to the file.
		const shadowed = {
			...inherited,
			'tsconfig.json': '{ "compilerOptions": { "paths": { "~server": ["./src/db/tables.ts"] } } }\n',
			'web/tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
		}
		expect(await refusals(shadowed, ['spa-server-import'])).toEqual([])
	})

	test('through the exact or most specific mapping, whatever the order', async () => {
		expect(
			await refusals({
				...ARCHITECTURE_APP,
				'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./web/*"], "@/server": ["./src/db/tables.ts"] } } }\n',
				'package.json': '{ "imports": { "#q/*": "./web/*", "#q/db/*": "./src/db/*" } }\n',
				'web/server.ts': 'export const shown = true\n',
				'web/main.ts': withImport('web/main.ts', "import { tables } from '@/server'\nimport { columns } from '#q/db/schema.generated.ts'"),
			}, ['spa-server-import']),
		).toEqual(['web/main.ts:1:1 spa-server-import', 'web/main.ts:2:1 spa-server-import'])
	})

	test('a Node builtin, with or without node:, subpaths included', async () => {
		expect(
			await refusals({
				...ARCHITECTURE_APP,
				'web/main.ts': withImport('web/main.ts', "export { readFileSync } from 'fs'\nimport { readFile } from 'fs/promises'\nimport 'node:path'"),
			}, ['spa-server-import']),
		).toEqual(['web/main.ts:1:1 spa-server-import', 'web/main.ts:2:1 spa-server-import', 'web/main.ts:3:1 spa-server-import'])
	})

	test("logic and queries keep their layer's restriction through local modules", async () => {
		const support = { ...ARCHITECTURE_APP, 'src/deals/support.ts': "export { compileContract } from '@fabrika/app/contract'\n" }
		const named = { ...support, 'src/deals/queries.ts': withImport('src/deals/queries.ts', "import { compileContract } from './support'") }
		expect(await refusals(named, ['layer-import'])).toEqual(['src/deals/queries.ts:1:1 layer-import'])

		const star = {
			...ARCHITECTURE_APP,
			'src/deals/support.ts': "export * from '@fabrika/app/contract'\n",
			'src/deals/logic.ts': withImport('src/deals/logic.ts', "export * from './support'"),
		}
		expect(await refusals(star, ['layer-import'])).toEqual(['src/deals/logic.ts:1:1 layer-import'])

		const dynamic = { ...support, 'src/deals/queries.ts': withImport('src/deals/queries.ts', "export const load = () => import('./support')") }
		expect(await refusals(dynamic, ['layer-import'])).toEqual(['src/deals/queries.ts:1:27 layer-import'])

		const cycle = {
			...ARCHITECTURE_APP,
			'src/deals/support.ts': "import './queries'\nexport * from './deeper'\n",
			'src/deals/deeper.ts': "import './support'\nexport { serve } from '@fabrika/app/implement'\n",
			'src/deals/queries.ts': withImport('src/deals/queries.ts', "import './support'"),
		}
		expect(await refusals(cycle, ['layer-import'])).toEqual(['src/deals/queries.ts:1:1 layer-import'])
	})

	test("the SPA's schema modules are held to the SPA's imports", async () => {
		const files = {
			...ARCHITECTURE_APP,
			'src/schemas/server.ts': "export * from '@fabrika/app/implement'\n",
			'src/schemas/shared.ts': "export * from './server'\n",
			'web/main.ts': withImport(
				'web/main.ts',
				"import { serve } from '../src/schemas/shared'\nexport const later = () => import('../src/schemas/server')",
			),
		}
		expect(await refusals(files, ['spa-server-import'])).toEqual(['web/main.ts:1:1 spa-server-import', 'web/main.ts:2:28 spa-server-import'])
	})
})

describe('fabrika-check', () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
	})

	const run = async (
		files: Readonly<Record<string, string>>,
	): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
		const root = await mkdtemp(join(tmpdir(), 'fabrika-check-structure-'))
		roots.push(root)
		for (const [path, text] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true })
			await writeFile(join(root, path), text)
		}
		const child = Bun.spawn(['bun', CLI, root], { stdout: 'pipe', stderr: 'pipe' })
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
		return { code, stdout, stderr }
	}

	const HINTED = { ...CLEAN_APPLICATION, 'src/notes/format.ts': 'export const titles = async ({ ctx }) => ctx.db.within.notes.list()\n' }

	test('exits 0 with hints only, and prints them under their own heading', async () => {
		const result = await run(HINTED)

		expect(result.code).toBe(0)
		expect(result.stdout).toBe(
			'Hints — the application architecture; they do not fail the check:\n'
				+ "src/notes/format.ts:1:42 data-access-location data access outside a slice's endpoints.ts and queries.ts "
				+ '(allowed form: ctx.db and ctx.sql in a handler of src/<slice>/endpoints.ts; reusable data access in src/<slice>/queries.ts, over the handle the handler passes in)\n',
		)
		expect(result.stderr).toBe('fabrika-check: 0 refusals, 1 hint\n')
	})

	test('exits 1 on each integrity break that only Bun-like resolution sees', async () => {
		const breaks: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
			['src/__tests__/authored.test.ts:2:1 generated-test-import', {
				'src/__tests__/package.json': '{ "imports": { "#generated": "./endpoint-access.test.ts" } }\n',
				'src/__tests__/authored.test.ts': "import { expect, test } from 'bun:test'\nimport '#generated'\n\ntest('runs', () => expect(1).toBe(1))\n",
			}],
			['src/notes/queries.ts:1:1 test-only-import', {
				'src/notes/package.json': '{ "imports": { "#kit": "@fabrika/app/testing" } }\n',
				'src/notes/queries.ts': "import { testKit } from '#kit'\n\nexport const kit = testKit\n",
			}],
			['web/main.ts:1:1 spa-server-import', {
				'tsconfig.base.json': '{ "compilerOptions": { "paths": { "~server": ["./src/db/tables.ts"] } } }\n',
				'web/tsconfig.json': '{ "extends": "../tsconfig.base.json" }\n',
				'web/main.ts': "import { tables } from '~server'\n\nexport const shown = tables\n",
			}],
		]
		for (const [expected, files] of breaks) {
			const result = await run({ ...CLEAN_APPLICATION, ...files })
			expect(result.code).toBe(1)
			expect(result.stdout.split('\n').map((line) => line.split(' ').slice(0, 2).join(' '))).toContain(expected)
		}
	})

	test('exits 1 with a refusal, and prints the refusals before the hints', async () => {
		const result = await run({ ...HINTED, 'web/main.ts': "import { tables } from '../src/db/tables'\n\nexport const shown = tables\n" })

		expect(result.code).toBe(1)
		expect(result.stdout.split('\n').map((line) => line.split(' ')[0])).toEqual([
			'web/main.ts:1:1',
			'Hints',
			'src/notes/format.ts:1:42',
			'',
		])
		expect(result.stderr).toBe('fabrika-check: 1 refusal, 1 hint\n')
	})
})
