import { describe, expect, test } from 'bun:test'
import type { RuleId } from '../finding'
import { RULE_IDS } from '../finding'
import { generatedTestHeader } from '../rules/tests'
import { generatedTests, scaffoldInputs } from '../scaffold'
import { check, CLEAN_APPLICATION, CLEAN_CONTRACT, CLEAN_GENERATED_TESTS, CLEAN_SCHEMAS, CLEAN_TABLES, locations } from './helpers'

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
		rule: 'contract',
		bad: {
			...CLEAN_APPLICATION,
			'fabrika.contract.ts': CLEAN_CONTRACT.replace("health: c.health('/healthz'),", "health: { kind: 'health', path: '/healthz' },"),
		},
		expected: ['fabrika.contract.ts:15:10'],
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
		rule: 'test-only-import',
		bad: {
			'package.json': JSON.stringify({ imports: { '#kit': '@fabrika/app/testing' } }),
			'src/app.ts': [
				"import { testKit } from '@fabrika/app/testing'",
				"export * from '@fabrika/app/testing'",
				"export const later = await import('@fabrika/app/testing')",
				"import { signer } from './__tests__/helpers.ts'",
				"export { other } from './kit.test.ts'",
				"export { mapped } from './mapped.ts'",
				'export { testKit, signer }',
				'',
			].join('\n'),
			'src/helper.ts': "export { testKit as viaHelper } from '@fabrika/app/testing'\n",
			'src/mapped.ts': "export { testKit as mapped } from '#kit'\n",
			'src/seed.ts': "export { testDatabase } from '@fabrika/db/testing'\n",
			'src/via-directory.ts': "export * from './__tests__'\n",
			'src/__tests__/index.ts': "export { testDatabase } from '@fabrika/db/testing'\n",
			'src/__tests__/helpers.ts': "export { testKit as signer } from '@fabrika/app/testing'\n",
			'src/kit.test.ts': "export { testKit as other } from '@fabrika/app/testing'\n",
		},
		expected: [
			'src/app.ts:1:1',
			'src/app.ts:2:1',
			'src/app.ts:3:28',
			'src/app.ts:4:1',
			'src/app.ts:5:1',
			'src/helper.ts:1:1',
			'src/mapped.ts:1:1',
			'src/seed.ts:1:1',
			'src/via-directory.ts:1:1',
		],
		good: {
			'src/app.ts': "import type { TestCaller } from '@fabrika/app/testing'\n\nexport type Caller = TestCaller\n",
			'src/__tests__/helpers.ts': "export { testKit } from '@fabrika/app/testing'\n",
			'src/__tests__/notes.test.ts': [
				"import { expect, test } from 'bun:test'",
				"import { testKit } from './helpers.ts'",
				'',
				"test('the kit is loaded', () => {",
				"\texpect(typeof testKit).toBe('function')",
				'})',
				'',
			].join('\n'),
		},
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
		rule: 'package-replacement',
		bad: {
			'package.json': [
				'{',
				'\t"name": "@fabrika/app",',
				'\t"exports": { "./build": "./dist/build.js" },',
				'\t"dependencies": {',
				'\t\t"@fabrika/app": "workspace:*",',
				'\t\t"zod": "^3.25.76"',
				'\t},',
				'\t"overrides": { "zod": "npm:other-zod@1.0.0" }',
				'}',
				'',
			].join('\n'),
			'bun.lock': [
				'{',
				'  "lockfileVersion": 1,',
				'  "packages": {',
				'    "@fabrika/app": ["@fabrika/app@github:someone/app#main", {}, "someone-app"],',
				'    "zod": ["zod@3.25.76", "", {}, "sha512-AAAA"],',
				'    "kysely": ["kysely@0.29.6", "", {}, "sha512-BBBB"],',
				'  },',
				'}',
				'',
			].join('\n'),
			'bunfig.toml': '[install]\nregistry = "https://registry.example.test"\n',
			'.npmrc': '@fabrika:registry=https://registry.example.test\n',
			'src/types.d.ts': "declare module '@fabrika/app' {\n\texport const app: number\n}\n",
			'packages/web/package.json': '{ "name": "zod" }\n',
		},
		expected: [
			'.npmrc:1:1',
			'bun.lock:4:5',
			'bunfig.toml:2:1',
			'package.json:2:2',
			'package.json:3:2',
			'package.json:5:3',
			'package.json:8:2',
			'packages/web/package.json:1:3',
			'src/types.d.ts:1:1',
		],
		good: {
			'package.json': '{\n\t"name": "notes",\n\t"dependencies": { "@fabrika/app": "^0.0.4", "zod": "3.25.76" }\n}\n',
			'packages/web/package.json': '{ "name": "notes-web", "exports": { ".": "./src/index.ts" } }\n',
			'bun.lock': '{\n  "lockfileVersion": 1,\n  "packages": {\n    "@fabrika/app": ["@fabrika/app@0.0.4", "", {}, "sha512-AAAA"],\n  },\n}\n',
			'bunfig.toml': '[install]\nexact = true\n',
			'.npmrc': 'save-exact=true\n',
			'src/types.d.ts': "declare module 'some-library' {\n\texport const value: number\n}\n",
		},
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
		rule: 'endpoint-fixture',
		bad: { ...CLEAN_APPLICATION, 'src/__tests__/endpoint-access.fixtures.ts': "export const fixtures = { 'api.gone': { id: 'x' } }\n" },
		expected: ['src/__tests__/endpoint-access.fixtures.ts:1:1'],
		good: CLEAN_APPLICATION,
	},
	{
		rule: 'mock-module',
		bad: {
			'src/app.ts': [
				"import { mock } from 'bun:test'",
				"mock.module('bun:test', () => ({ test: () => {} }))",
				"mock.module('@fabrika/app/testing/isolation', () => ({}))",
				"mock.module('./__tests__/endpoint-access.test.ts', () => ({}))",
				"const name = 'bun:' + 'test'",
				'mock.module(name, () => ({}))',
				'',
			].join('\n'),
			'src/__tests__/endpoint-access.test.ts': '',
		},
		expected: ['src/app.ts:2:1', 'src/app.ts:3:1', 'src/app.ts:4:1', 'src/app.ts:6:1'],
		good: {
			'src/__tests__/notes.test.ts': [
				"import { expect, mock, test } from 'bun:test'",
				'',
				"mock.module('../mailer.ts', () => ({ send: () => true }))",
				'',
				"test('sends', () => {",
				'\texpect(1).toBe(1)',
				'})',
				'',
			].join('\n'),
			'src/mailer.ts': 'export const send = (): boolean => false\n',
		},
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

describe('generated tests', () => {
	const path = 'src/db/__tests__/notes.policy-isolation.test.ts'
	const endpoints = 'src/__tests__/endpoint-access.test.ts'
	const generated = CLEAN_GENERATED_TESTS.get(path) ?? ''
	const body = generated.slice(generated.indexOf('\n') + 1)
	const weakened = body.replace("expect((await kit.get('other')).status).toBe(404)", "expect((await kit.get('other')).status).toBe(200)")
	const findingsOf = async (files: Readonly<Record<string, string>>): Promise<string[]> =>
		(await check(files)).map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.message}`)
	const replaced = `${path}:1:1 generated-test-hash this file is not the generated test the scaffold writes here`

	test('the scaffold writes a policy test per table a store reaches and the endpoint test, as the clean application carries them', async () => {
		expect([...CLEAN_GENERATED_TESTS.keys()]).toEqual([path, endpoints])
		expect(generated.startsWith('// @generated by fabrika db test-scaffold sha256:')).toBe(true)
		expect(CLEAN_GENERATED_TESTS.get(endpoints)).toContain(
			"expect(await kit.denied('api.get', { id: '00000000-0000-4000-8000-000000000000' })).toEqual({ status: 404 })",
		)
		expect(await check(CLEAN_APPLICATION)).toEqual([])
	})

	test('a weakened generated test fails the check: its hash no longer matches', async () => {
		expect(weakened).not.toBe(body)
		expect(await findingsOf({ ...CLEAN_APPLICATION, [path]: `${generated.slice(0, generated.indexOf('\n'))}\n${weakened}` })).toEqual([
			`${path}:1:1 generated-test-hash this generated test differs from what fabrika db test-scaffold wrote`,
		])
	})

	test('a weakened test under a recomputed hash fails too', async () => {
		expect(await findingsOf({ ...CLEAN_APPLICATION, [path]: `${await generatedTestHeader(weakened)}\n${weakened}` })).toEqual([replaced])
	})

	test('a replacement without the header fails: every generated file is compared byte for byte', async () => {
		expect(await findingsOf({ ...CLEAN_APPLICATION, [path]: body })).toEqual([replaced])
		const smoke = "import { expect, test } from 'bun:test'\n\ntest('smoke', () => {\n\texpect(1).toBe(1)\n})\n"
		expect(await findingsOf({ ...CLEAN_APPLICATION, [path]: smoke })).toEqual([replaced])
		expect(await findingsOf({ ...CLEAN_APPLICATION, [path]: '' })).toEqual([replaced])
	})

	test('a deleted generated test is a finding', async () => {
		const { [path]: _deleted, ...rest } = CLEAN_APPLICATION
		expect(await findingsOf(rest)).toEqual([`${path}:1:1 generated-test-hash this generated test is missing`])
		const { [endpoints]: _endpoints, ...withoutEndpoints } = CLEAN_APPLICATION
		expect(await findingsOf(withoutEndpoints)).toEqual([`${endpoints}:1:1 generated-test-hash this generated test is missing`])
	})

	test('a policy change makes the generated test stale until the scaffold reruns', async () => {
		const narrowed = CLEAN_TABLES.replace(", delete: 'notes.write'", '')
		expect(narrowed).not.toBe(CLEAN_TABLES)
		expect(await findingsOf({ ...CLEAN_APPLICATION, 'src/db/tables.ts': narrowed })).toEqual([replaced])
	})

	test('a generated test the scaffold no longer writes is a finding', async () => {
		const orphan = 'src/db/__tests__/countries.policy-isolation.test.ts'
		expect(await findingsOf({ ...CLEAN_APPLICATION, [orphan]: generated })).toEqual([
			`${orphan}:1:1 generated-test-hash a generated test the scaffold no longer writes`,
		])
	})

	test('an endpoint input the scaffold cannot sample needs a fixture, and the fixture becomes the case', async () => {
		const contract = CLEAN_CONTRACT.replace('input: z.strictObject({ id: z.uuid() })', 'input: z.strictObject({ id: z.string().regex(/^n-[0-9]+$/) })')
		expect(contract).not.toBe(CLEAN_CONTRACT)
		const sources = { ...CLEAN_APPLICATION, 'fabrika.contract.ts': contract }
		const generatedFor = async (files: Readonly<Record<string, string>>): Promise<Record<string, string>> => {
			const inputs = scaffoldInputs(new Map(Object.entries(files)))
			return Object.fromEntries([...(await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures))].map(([file, test]) => [file, test.text]))
		}
		const without = { ...sources, ...(await generatedFor(sources)) }
		expect(await findingsOf(without)).toEqual([
			'src/__tests__/endpoint-access.fixtures.ts:1:1 endpoint-fixture api.get: the scaffold cannot write an input its schema admits, so its endpoint access cases need one here',
		])
		const fixture = "export const fixtures = { 'api.get': { id: 'n-1' } }\n"
		const given = { ...sources, 'src/__tests__/endpoint-access.fixtures.ts': fixture }
		const withFixture: Record<string, string> = { ...given, ...(await generatedFor(given)) }
		expect(withFixture[endpoints]).toContain("expect(await kit.denied('api.get', { id: 'n-1' })).toEqual({ status: 404 })")
		expect(await findingsOf(withFixture)).toEqual([])
		const computed = {
			...withFixture,
			'src/__tests__/endpoint-access.fixtures.ts': "const id = 'n-1'\nexport const fixtures = { 'api.get': { id } }\n",
		}
		expect((await findingsOf(computed)).map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual([
			'src/__tests__/endpoint-access.fixtures.ts:1:1 endpoint-fixture',
		])
	})

	test('a file collection gets cross-scope cases, and a removal weakened to the read action makes the committed test stale', async () => {
		const collection = (remove: string) =>
			`\tfiles: { attachments: c.files({ owner: 'notes', read: 'notes.read', write: 'notes.write', delete: '${remove}', maxBytes: 1024, types: ['text/plain'] }) },\n`
		const withFiles = (remove: string) =>
			CLEAN_CONTRACT.replace("\thealth: c.health('/healthz'),\n", `${collection(remove)}\thealth: c.health('/healthz'),\n`)
		const generatedFor = async (files: Readonly<Record<string, string>>): Promise<Record<string, string>> => {
			const inputs = scaffoldInputs(new Map(Object.entries(files)))
			return Object.fromEntries([...(await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures))].map(([file, test]) => [file, test.text]))
		}
		const sources = { ...CLEAN_APPLICATION, 'fabrika.contract.ts': withFiles('notes.write') }
		const application: Record<string, string> = { ...sources, ...(await generatedFor(sources)) }
		const endpointTest = application[endpoints] ?? ''
		for (
			const line of [
				"expect(await kit.denied('files.attachments.remove', { id: '00000000-0000-4000-8000-000000000000' })).toEqual({ status: 404 })",
				"expect(await kit.leaked('files.attachments.remove', { id: '00000000-0000-4000-8000-000000000000' })).toEqual({ status: 200, leaked: [] })",
				"expect(await kit.file('attachments', 'upload', 'other')).toEqual({ status: 404 })",
				"expect(await kit.file('attachments', 'download', 'other')).toEqual({ status: 404 })",
				"expect(await kit.file('attachments', 'remove', 'reader')).toEqual({ status: 403 })",
			]
		) expect(endpointTest).toContain(line)
		expect(await findingsOf(application)).toEqual([])
		expect(await findingsOf({ ...application, 'fabrika.contract.ts': withFiles('notes.read') })).toEqual([
			`${endpoints}:1:1 generated-test-hash this file is not the generated test the scaffold writes here`,
		])
	})

	test('policies the reader refuses are reported, so they cannot silence the check', async () => {
		const refused = CLEAN_TABLES.replace("insert: ['title']", "insert: ['title', 'missing']")
		const findings = await check({ ...CLEAN_APPLICATION, 'src/db/tables.ts': refused })
		expect(findings.map((finding) => `${finding.file} ${finding.rule}`)).toEqual(['src/db/tables.ts contract'])
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

describe('bunfig.toml is read as Bun reads it', () => {
	const bunfig = async (text: string): Promise<string[]> =>
		(await check({ ...CLEAN_APPLICATION, 'bunfig.toml': text })).filter((finding) => finding.file === 'bunfig.toml').map((finding) =>
			`${finding.line} ${finding.message}`
		)

	test('a runtime preload is refused under every spelling of its key', async () => {
		for (const key of ['preload', '"preload"', "'preload'", '"pre\\u006coad"']) {
			expect(await bunfig(`smol = true\n${key} = ["./dist/preload.js"]\n`)).toEqual([
				'2 a runtime preload can register a plugin that redirects any import, trusted packages included',
			])
		}
	})

	test('a test preload into a skipped or generated path is refused, one into checked source is not', async () => {
		const refused = 'a test preload outside the checked application files runs unchecked in the platform build'
		for (const target of ['./dist/after-checks.js', './fabrika/entry.generated.ts', './node_modules/x/index.js', '../outside.ts', 'some-package']) {
			expect(await bunfig(`[test]\npreload = ["${target}"]\n`)).toEqual([`2 ${refused}`])
		}
		expect(await bunfig(`test.preload = "./dist/after-checks.js"\n`)).toEqual([`1 ${refused}`])
		expect(await bunfig('[test]\npreload = ["./src/test-setup.ts"]\n')).toEqual([])
	})

	test('a file outside the TOML subset is refused rather than guessed at', async () => {
		expect(await bunfig('preload = """\n./dist/preload.js\n"""\n')).toEqual([
			'1 bunfig.toml line 1 is outside the TOML the platform reads (a multi-line string)',
		])
		expect(await bunfig('[install]\nregistry = { url = "https://registry.example.test" }\n')).toEqual([
			'2 bunfig.toml line 2 is outside the TOML the platform reads (an inline table)',
		])
	})

	test('a [test] key that narrows the suite is refused under every spelling', async () => {
		expect(await bunfig('[test]\nroot = "unit"\npathIgnorePatterns = ["src/db/**"]\nretry = 3\nsmol = true\n')).toEqual([
			'2 [test] root changes which tests run or whether a failure counts',
			'3 [test] pathIgnorePatterns changes which tests run or whether a failure counts',
			'4 [test] retry changes which tests run or whether a failure counts',
		])
		expect(await bunfig('test.root = "unit"\n')).toEqual(['1 [test] root changes which tests run or whether a failure counts'])
	})

	test('a quoted registry key is another registry', async () => {
		expect(await bunfig('[install]\n"registry" = "https://registry.example.test"\n')).toEqual([
			'2 another registry can serve a package the platform trusts by name',
		])
	})
})
