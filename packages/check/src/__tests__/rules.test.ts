import { describe, expect, test } from 'bun:test'
import type { RuleId } from '../finding'
import { RULE_IDS } from '../finding'
import { generatedTestHeader } from '../rules/tests'
import { check, CLEAN_APPLICATION, CLEAN_CONTRACT, CLEAN_SCHEMAS, locations } from './helpers'

interface RuleCase {
	readonly rule: RuleId
	/** Files that break the rule, and where each break is reported. */
	readonly bad: Readonly<Record<string, string>>
	readonly expected: readonly string[]
	/** Files in the allowed form; they must produce no finding of any rule. */
	readonly good: Readonly<Record<string, string>>
}

const ZEROPS_YAML = `zerops:
  - setup: app
    run:
      start: bun fabrika/entry.generated.ts
      crontab:
        - timing: '0 3 * * *'
          command: fabrika job run purgeDeleted
          allContainers: false
`

const cases: readonly RuleCase[] = [
	{
		rule: 'parse-error',
		bad: { 'src/broken.ts': 'export const a = {\n\tb: 1,,\n}\n' },
		expected: ['src/broken.ts:2:7'],
		good: { 'src/fine.ts': 'export const a = { b: 1 }\n' },
	},
	{
		rule: 'literal',
		bad: {
			...CLEAN_APPLICATION,
			'fabrika.contract.ts': CLEAN_CONTRACT.replace("app: 'notes'", 'app: appName').replace(
				'export const contract',
				"const appName = 'notes'.trim()\nexport const contract",
			),
			'src/schemas/notes.ts': `${CLEAN_SCHEMAS}export const Title = z.string().refine((value) => value !== '')\n`,
			'src/db/tables.ts': "import { defineTables } from '@fabrika/db'\n\nlet notes = {}\nexport const tables = defineTables()({ notes })\n",
		},
		expected: [
			'fabrika.contract.ts:5:17',
			'src/db/tables.ts:3:1',
			'src/db/tables.ts:4:40',
			'src/schemas/notes.ts:5:22',
		],
		good: CLEAN_APPLICATION,
	},
	{
		rule: 'forbidden-import',
		bad: {
			'src/data.ts': [
				"import postgres from 'postgres'",
				"import { S3Client } from '@aws-sdk/client-s3'",
				"import { jwtVerify } from 'jose'",
				"import http from 'node:http'",
				"import { spawn } from 'child_process'",
				"export const pg = await import('pg/lib/client')",
				"export const net = require('net')",
				'export { postgres, S3Client, jwtVerify, http, spawn }',
				'',
			].join('\n'),
		},
		expected: ['src/data.ts:1:1', 'src/data.ts:2:1', 'src/data.ts:3:1', 'src/data.ts:4:1', 'src/data.ts:5:1', 'src/data.ts:6:25', 'src/data.ts:7:20'],
		good: { 'src/data.ts': "import type { Selectable } from 'kysely'\n\nexport type Row = Selectable<{ id: string }>\n" },
	},
	{
		rule: 'unchecked-import',
		bad: {
			'src/a.ts':
				"import { x } from '../../shared/x'\nimport { y } from '../dist/y.js'\nimport { z } from '../node_modules/pg/index.js'\nexport { x, y, z }\n",
		},
		expected: ['src/a.ts:1:1', 'src/a.ts:2:1', 'src/a.ts:3:1'],
		good: { 'src/a.ts': "import { x } from './lib/x'\nexport { x }\n", 'src/lib/x.ts': 'export const x = 1\n' },
	},
	{
		rule: 'forbidden-global',
		bad: {
			'src/server.ts': [
				"Bun.serve({ fetch: () => new Response('') })",
				"Bun.spawn(['ls'])",
				'export const query = globalThis.Bun.sql',
				'const { connect } = Bun',
				"import { serve } from 'bun'",
				'export { connect, serve }',
				'',
			].join('\n'),
		},
		expected: ['src/server.ts:1:1', 'src/server.ts:2:1', 'src/server.ts:3:22', 'src/server.ts:4:21', 'src/server.ts:5:1'],
		good: { 'src/files.ts': "import { file } from 'bun'\n\nexport const read = () => Bun.file('notes.txt').text()\nexport { file }\n" },
	},
	{
		rule: 'raw-sql',
		bad: {
			'src/db/stores/notes.ts':
				"import { sql } from '@fabrika/db'\n\nexport const all = sql`select * from notes`\nexport const raw = sql.raw('drop table notes')\n",
		},
		expected: ['src/db/stores/notes.ts:1:10', 'src/db/stores/notes.ts:3:20', 'src/db/stores/notes.ts:4:20'],
		good: { 'src/db/stores/notes.ts': "export const sqlName = 'notes'\nexport const list = (store: { list(): string[] }) => store.list()\n" },
	},
	{
		rule: 'type-assertion',
		bad: { 'src/a.ts': 'declare const value: unknown\nexport const text = value as string\nexport const other = <number>value\n' },
		expected: ['src/a.ts:2:21', 'src/a.ts:3:22'],
		good: { 'src/a.ts': "export const tags = ['a', 'b'] as const\nexport const config = { port: 1 } satisfies { port: number }\n" },
	},
	{
		rule: 'any-type',
		bad: { 'src/a.ts': 'export const parse = (input: any): Array<any> => [input]\n' },
		expected: ['src/a.ts:1:30', 'src/a.ts:1:42'],
		good: { 'src/a.ts': 'export const parse = (input: unknown): unknown[] => [input]\n' },
	},
	{
		rule: 'suppression-comment',
		bad: {
			'src/a.ts': [
				'// @ts-ignore',
				'export const a = 1',
				'// @ts-expect-error -- legacy',
				'export const b = 2',
				'/* @ts-nocheck */',
				'// biome-ignore lint/suspicious/noExplicitAny: legacy',
				'// eslint-disable-next-line',
				'',
			].join('\n'),
		},
		expected: ['src/a.ts:1:1', 'src/a.ts:3:1', 'src/a.ts:5:1', 'src/a.ts:6:1', 'src/a.ts:7:1'],
		good: { 'src/a.ts': '// Counts notes per workspace.\nexport const a = 1\n' },
	},
	{
		rule: 'capability-widening',
		bad: {
			'src/a.ts':
				"import type { Ref, Within } from '@fabrika/app'\n\nexport type Any = Ref<string, 'notes.read'>\nexport type Scope = Within<'workspace', string>\n",
		},
		expected: ['src/a.ts:3:19', 'src/a.ts:4:21'],
		good: { 'src/a.ts': "import type { Ref } from '@fabrika/app'\n\nexport type Note = Ref<'note', 'notes.read'>\n" },
	},
	{
		rule: 'prototype-assignment',
		bad: {
			'src/patch.ts': [
				"import { Ref } from '@fabrika/app'",
				'Ref.prototype.check = () => true',
				'Object.setPrototypeOf(Ref, Object)',
				"Object.defineProperty(Ref.prototype, 'action', { value: 'x' })",
				'declare const target: { __proto__: unknown }',
				'target.__proto__ = null',
				'',
			].join('\n'),
		},
		expected: ['src/patch.ts:2:1', 'src/patch.ts:3:1', 'src/patch.ts:4:1', 'src/patch.ts:6:1'],
		good: { 'src/state.ts': 'const state = { count: 0 }\nstate.count = 1\nexport { state }\n' },
	},
	{
		rule: 'env-read',
		bad: {
			'src/config.ts': [
				'export const url = process.env.DATABASE_URL',
				'export const token = Bun.env.TOKEN',
				'const { env } = process',
				"import { env as environment } from 'node:process'",
				'export { env, environment }',
				'',
			].join('\n'),
		},
		expected: ['src/config.ts:1:20', 'src/config.ts:2:22', 'src/config.ts:3:17', 'src/config.ts:4:1'],
		good: {
			'fabrika/entry.generated.ts': "export const env = { origin: process.env.FABRIKA_ORIGIN ?? '' }\n",
			'src/exit.ts': 'export const fail = () => {\n\tprocess.exitCode = 1\n}\n',
		},
	},
	{
		rule: 'public-env',
		bad: {
			'src/spa/config.ts': 'export const secret = import.meta.env.API_SECRET\nexport const all = import.meta.env\nexport const { env } = import.meta\n',
		},
		expected: ['src/spa/config.ts:1:23', 'src/spa/config.ts:2:20', 'src/spa/config.ts:3:14'],
		good: { 'src/spa/config.ts': 'export const origin = import.meta.env.FABRIKA_PUBLIC_ORIGIN\n' },
	},
	{
		rule: 'cross-app-fetch',
		bad: {
			'src/sync.ts': [
				"export const a = fetch('https://billing.example.com/api/invoices')",
				'export const b = (host: string) => fetch(`https://${host}/api/notes.list`)',
				"export const c = fetch(new URL('http://notesapi:3000/api'))",
				'',
			].join('\n'),
		},
		expected: ['src/sync.ts:1:18', 'src/sync.ts:2:36', 'src/sync.ts:3:18'],
		good: {
			'src/spa/api.ts': "export const list = () => fetch('/api/notes.list', { method: 'POST', body: '{}' })\n"
				+ 'export const call = (name: string) => fetch(`/api/${name}`)\n',
		},
	},
	{
		rule: 'key-literal',
		bad: { 'src/a.ts': "export const key = 'px_live_4f2a'\nexport const cookie = `__Host-px_session`\n" },
		expected: ['src/a.ts:1:20', 'src/a.ts:2:24'],
		good: { 'src/a.ts': "export const label = 'pixel'\n" },
	},
	{
		rule: 'client-identity',
		bad: {
			...CLEAN_APPLICATION,
			'fabrika.contract.ts': CLEAN_CONTRACT.replace(
				'create: c.mutation({ input: CreateNote,',
				'create: c.mutation({ input: CreateNote.extend({ ownerId: z.uuid() }),',
			).replace(
				'get: c.query({ input: z.strictObject({ id: z.uuid() }),',
				'get: c.query({ input: z.strictObject({ id: z.uuid(), workspaceId: z.uuid() }),',
			),
		},
		expected: ['fabrika.contract.ts:12:25', 'fabrika.contract.ts:13:31'],
		good: CLEAN_APPLICATION,
	},
	{
		rule: 'sensitive-log',
		bad: {
			'src/log.ts': [
				'export const run = async (job: () => Promise<void>, req: Request) => {',
				'\ttry {',
				'\t\tawait job()',
				'\t} catch (failure) {',
				'\t\tconsole.error(failure)',
				'\t}',
				'\tconsole.log(req.headers)',
				"\tconsole.info('request', JSON.stringify({ request: req }))",
				'}',
				'',
			].join('\n'),
		},
		expected: ['src/log.ts:5:17', 'src/log.ts:7:14', 'src/log.ts:8:52'],
		good: {
			'src/log.ts': [
				'export const run = async (job: () => Promise<void>, count: number) => {',
				'\ttry {',
				'\t\tawait job()',
				'\t} catch (failure) {',
				"\t\tconsole.error('job failed', failure instanceof Error ? failure.message : 'unknown failure')",
				'\t}',
				"\tconsole.log('processed', count)",
				'}',
				'',
			].join('\n'),
		},
	},
	{
		rule: 'unsafe-html',
		bad: {
			'src/spa/view.tsx': [
				'export const render = (element: HTMLElement, html: string) => {',
				'\telement.innerHTML = html',
				"\telement.insertAdjacentHTML('beforeend', html)",
				'\treturn <div dangerouslySetInnerHTML={{ __html: html }} />',
				'}',
				'',
			].join('\n'),
		},
		expected: ['src/spa/view.tsx:2:2', 'src/spa/view.tsx:3:2', 'src/spa/view.tsx:4:14'],
		good: {
			'src/spa/view.tsx':
				'export const render = (element: HTMLElement, text: string) => {\n\telement.textContent = text\n\treturn <div>{text}</div>\n}\n',
		},
	},
	{
		rule: 'dynamic-code',
		bad: {
			'src/spa/run.ts': [
				'export const a = (code: string) => eval(code)',
				"export const b = new Function('a', 'return a')",
				"setTimeout('refresh()', 1000)",
				'',
			].join('\n'),
		},
		expected: ['src/spa/run.ts:1:36', 'src/spa/run.ts:2:18', 'src/spa/run.ts:3:1'],
		good: {
			'src/spa/run.ts':
				'export const later = (run: () => void) => setTimeout(() => run(), 1000)\nexport const isFunction = (value: unknown) => value instanceof Function\n',
		},
	},
	{
		rule: 'migration-name',
		bad: {
			'db/migrations/init.sql': '',
			'db/migrations/20261308120000_init.sql': '',
			'db/migrations/20261008120000_AddNotes.sql': '',
			'db/migrations/old/20261008120000_init.sql': '',
			'db/migrations/20261008120000_init.txt': '',
		},
		expected: [
			'db/migrations/20261008120000_AddNotes.sql:1:1',
			'db/migrations/20261008120000_init.txt:1:1',
			'db/migrations/20261308120000_init.sql:1:1',
			'db/migrations/init.sql:1:1',
			'db/migrations/old/20261008120000_init.sql:1:1',
		],
		good: { 'db/migrations/20261008120000_init.sql': '', 'db/migrations/20261008120001_add_notes.sql': '', 'db/seeds/example.sql': '' },
	},
	{
		rule: 'crontab',
		bad: {
			...CLEAN_APPLICATION,
			'zerops.yaml': `zerops:
  - setup: app
    run:
      start: bun loop.ts & bun fabrika/entry.generated.ts
      crontab:
        - timing: '0 4 * * *'
          command: fabrika job run purgeDeleted
        - timing: '* * * * *'
          command: bun scripts/cleanup.ts
          allContainers: false
`,
		},
		expected: ['zerops.yaml:4:1', 'zerops.yaml:7:1', 'zerops.yaml:7:1', 'zerops.yaml:9:1'],
		good: { ...CLEAN_APPLICATION, 'zerops.yaml': ZEROPS_YAML },
	},
	{
		rule: 'skipped-test',
		bad: {
			'src/__tests__/notes.test.ts': [
				"import { describe, expect, it, test } from 'bun:test'",
				"test.skip('lists', () => expect(1).toBe(1))",
				"describe.only('notes', () => {})",
				"it.todo('removes')",
				"test.skipIf(true)('moves', () => expect(1).toBe(1))",
				"xit('shares', () => expect(1).toBe(1))",
				'declare const xit: (name: string, run: () => void) => void',
				'',
			].join('\n'),
		},
		expected: [
			'src/__tests__/notes.test.ts:2:1',
			'src/__tests__/notes.test.ts:3:1',
			'src/__tests__/notes.test.ts:4:1',
			'src/__tests__/notes.test.ts:5:1',
			'src/__tests__/notes.test.ts:6:1',
		],
		good: { 'src/notes.test.ts': "import { expect, test } from 'bun:test'\n\ntest('lists', () => {\n\texpect([1]).toHaveLength(1)\n})\n" },
	},
	{
		rule: 'test-without-assertion',
		bad: { 'src/notes.test.ts': "import { test } from 'bun:test'\n\ntest('lists', async () => {\n\tawait Promise.resolve()\n})\n" },
		expected: ['src/notes.test.ts:3:1'],
		good: {
			'src/notes.spec.ts': [
				"import { it, test } from 'bun:test'",
				'declare const harness: { expectDenied(path: string): Promise<void> }',
				'declare const assert: { equal(left: unknown, right: unknown): void }',
				"test('denies', async () => {",
				"\tawait harness.expectDenied('/api/notes.remove')",
				'})',
				"it('adds', () => assert.equal(1 + 1, 2))",
				'',
			].join('\n'),
		},
	},
]

describe('every rule has a refused and an allowed fixture', () => {
	test('the table covers every rule id except generated-test-hash, which has its own suite', () => {
		expect(new Set([...cases.map((item) => item.rule), 'generated-test-hash'])).toEqual(new Set(RULE_IDS))
	})

	for (const item of cases) {
		test(`${item.rule}: refused`, async () => {
			expect(locations(await check(item.bad), item.rule)).toEqual([...item.expected])
		})
		test(`${item.rule}: allowed`, async () => {
			expect(await check(item.good)).toEqual([])
		})
	}
})

describe('generated isolation tests', () => {
	const body = "import { expect, test } from 'bun:test'\n\ntest('w2 is 404 for w1', () => {\n\texpect(404).toBe(404)\n})\n"

	test('a generated test whose content matches its header passes', async () => {
		const text = `${await generatedTestHeader(body)}\n${body}`
		expect(await check({ 'src/db/__tests__/notes.isolation.test.ts': text })).toEqual([])
	})

	test('a weakened generated test fails the check', async () => {
		const text = `${await generatedTestHeader(body)}\n${body.replace('expect(404).toBe(404)', 'expect(200).toBeDefined()')}`
		expect(locations(await check({ 'src/db/__tests__/notes.isolation.test.ts': text }), 'generated-test-hash')).toEqual([
			'src/db/__tests__/notes.isolation.test.ts:1:1',
		])
	})
})

describe('no suppression syntax', () => {
	test('a comment naming the checker does not silence a finding', async () => {
		const findings = await check({ 'src/a.ts': '// fabrika-check-ignore env-read\nexport const url = process.env.DATABASE_URL\n' })
		expect(locations(findings, 'env-read')).toEqual(['src/a.ts:2:20'])
	})
})

describe('the crontab follows the contract', () => {
	const crontab = (entries: string) => ({
		...CLEAN_APPLICATION,
		'zerops.yaml': `zerops:\n  - setup: app\n    run:\n      start: bun server.ts\n${entries}`,
	})

	test('a contract job with no crontab entry is reported', async () => {
		expect(locations(await check(crontab('')), 'crontab')).toEqual(['zerops.yaml:2:1'])
	})

	test('a second entry for the same job is reported', async () => {
		const entry = "        - timing: '0 3 * * *'\n          command: fabrika job run purgeDeleted\n          allContainers: false\n"
		const findings = await check(crontab(`      crontab:\n${entry}${entry}`))
		expect(findings.filter((finding) => finding.rule === 'crontab').map((finding) => finding.message)).toEqual([
			"job 'purgeDeleted' has a second crontab entry",
		])
	})

	test('a zerops.yaml that does not parse is reported, not thrown', async () => {
		expect(locations(await check({ 'zerops.yaml': 'zerops: [\n' }), 'crontab')).toEqual(['zerops.yaml:1:1'])
	})
})
