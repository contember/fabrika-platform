import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { RuleId } from '../finding'
import { RULE_IDS } from '../finding'
import { STRUCTURE_RULE_IDS } from '../rules/structure'
import { generatedTestHeader } from '../rules/tests'
import { generatedTests, scaffoldInputs } from '../scaffold'
import { readTree } from './colocated-helpers'
import {
	check,
	CLEAN_APPLICATION,
	CLEAN_CONTRACT,
	CLEAN_GENERATED_TESTS,
	CLEAN_SCHEMA_GENERATED,
	CLEAN_SCHEMAS,
	CLEAN_TABLES,
	locations,
} from './helpers'

/** The clean application with a file kind and a nullable file column of it on notes. */
const FILE_COLUMN_SOURCES: Readonly<Record<string, string>> = {
	...CLEAN_APPLICATION,
	'fabrika.contract.ts': CLEAN_CONTRACT.replace(
		"\thealth: c.health('/healthz'),\n",
		"\tfiles: { pictures: c.files({ types: ['image/png'], maxBytes: 1024 }) },\n\thealth: c.health('/healthz'),\n",
	),
	'src/db/tables.ts': CLEAN_TABLES.replace("\t\tinsert: ['title'],\n", "\t\tinsert: ['title'],\n\t\tfiles: { picture: 'pictures' },\n"),
	'src/db/schema.generated.ts': CLEAN_SCHEMA_GENERATED.replace('title: string }', 'title: string; picture: string | null }').replace(
		"'title']",
		"'title', 'picture']",
	),
}
const fileColumnInputs = scaffoldInputs(new Map(Object.entries(FILE_COLUMN_SOURCES)))
const FILE_COLUMN_APPLICATION: Readonly<Record<string, string>> = {
	...FILE_COLUMN_SOURCES,
	...Object.fromEntries([...(await generatedTests(fileColumnInputs.policies, fileColumnInputs.artifact))].map(([file, test]) => [file, test.text])),
}
/** A `fabrika.config.ts` that `@fabrika/provider-cloudflare`'s `defineApp` authors: the application runs on SQLite. */
const CLOUDFLARE_CONFIG =
	"import { defineApp } from '@fabrika/provider-cloudflare'\n\nexport default defineApp({ id: 'notes', resources: () => [] })\n"

/** The two-slice application, whose pipeline query declares sql. */
const ARCHITECTURE_APPLICATION: Readonly<Record<string, string>> = Object.fromEntries(
	readTree(join(import.meta.dir, 'fixtures', 'architecture-app'), ['.fixture', '.sql']),
)

/** The two-slice application's `deals.create` mutation, declaring an outside origin. */
const DEALS_ENDPOINTS = 'src/deals/endpoints.ts'
const DEALS_CREATE_EGRESS: Readonly<Record<string, string>> = {
	[DEALS_ENDPOINTS]: (ARCHITECTURE_APPLICATION[DEALS_ENDPOINTS] ?? '').replace(
		"access: { action: 'deals.write', in: 'company', from: 'companyId' } })",
		"access: { action: 'deals.write', in: 'company', from: 'companyId' }, egress: ['https://api.example.com'] })",
	),
}

/** The clean application on Cloudflare: its config, a file kind, `edit` applied to its contract, and the generated tests on the SQLite kit. */
const cloudflareApplication = async (
	fileKind: string,
	edit: (contract: string) => string = (contract) => contract,
): Promise<Readonly<Record<string, string>>> => {
	const sources = Object.fromEntries(Object.entries(CLEAN_APPLICATION).filter(([path]) => !CLEAN_GENERATED_TESTS.has(path)))
	const files = new Map(Object.entries({
		...sources,
		'fabrika.config.ts': CLOUDFLARE_CONFIG,
		'fabrika.contract.ts': edit(CLEAN_CONTRACT.replace(
			"\thealth: c.health('/healthz'),\n",
			`\tfiles: { pictures: ${fileKind} },\n\thealth: c.health('/healthz'),\n`,
		)),
	}))
	const inputs = scaffoldInputs(files)
	for (const [path, test] of await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures, inputs.dialect)) files.set(path, test.text)
	return Object.fromEntries(files)
}

/** The clean contract's one job, before its options close: where a case adds `limits`. */
const JOB_ACTIONS = "c.cron('0 3 * * *', { actions: ['notes.write']"

const NOTES_TABLE = 'CREATE TABLE notes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, picture UUID'

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
			'src/db/tables.ts': "import { defineTables } from '@fabrika/db/tables'\n\nlet notes = {}\nexport const tables = defineTables()({ notes })\n",
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
				"import { x } from '../../shared/x'\nimport { y } from '../dist/y.js'\nimport { z } from '../node_modules/pg/index.js'\nimport { w } from '../fabrika/assets/w.js'\nexport { x, y, z, w }\n",
		},
		expected: ['src/a.ts:1:1', 'src/a.ts:2:1', 'src/a.ts:3:1', 'src/a.ts:4:1'],
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
			// The global, also beside a function whose parameter of that name shadows it, and under an ambient declaration.
			'src/widths.ts': [
				'declare const self: { width: number }',
				'export const half = (window: { width: number }) => window.width / 2',
				'export const width = window.innerWidth',
				'export const own = self.width',
				'',
			].join('\n'),
		},
		expected: [
			'src/server.ts:1:1',
			'src/server.ts:2:1',
			'src/server.ts:3:22',
			'src/server.ts:4:21',
			'src/server.ts:5:1',
			'src/widths.ts:3:22',
			'src/widths.ts:4:20',
		],
		good: {
			// Outside src/ a build script still reaches Bun's other members; a server module only tests for a global.
			'scripts/files.ts': "import { file } from 'bun'\n\nexport const read = () => Bun.file('notes.txt').text()\nexport { file }\n",
			'src/runtime.ts': "export const inBrowser = typeof window !== 'undefined'\n",
			// A name the module binds itself is not the global: a const, a parameter, a catch binding, an import.
			'src/viewport.ts': [
				"import { global } from './regions'",
				'',
				'const window = { opensAt: 9, closesAt: 17 }',
				'export const hours = window.closesAt - window.opensAt',
				'export const scale = (self: { factor: number }) => self.factor * 2',
				'export const region = global.code',
				'export const failed = () => {',
				'\ttry {',
				'\t\treturn hours',
				'\t} catch (globalThis) {',
				'\t\treturn globalThis',
				'\t}',
				'}',
				'',
			].join('\n'),
			'src/regions.ts': "export const global = { code: 'eu' }\n",
		},
	},
	{
		rule: 'raw-sql',
		bad: {
			'src/db/stores/notes.ts':
				"import { sql } from '@fabrika/db'\n\nexport const all = sql`select * from notes`\nexport const raw = sql.raw('drop table notes')\n",
			// The driver's tag by its origin, whatever its local name.
			'src/db/stores/aliases.ts': [
				"import { sql as q } from 'kysely'",
				'',
				'export const all = q`select * from notes`',
				"export const raw = q.raw('drop table notes')",
				"const { sql: driver } = await import('bun')",
				'export const loaded = driver`select 1`',
				"export const called = driver('notes')",
				'',
			].join('\n'),
		},
		expected: [
			'src/db/stores/aliases.ts:1:10',
			'src/db/stores/aliases.ts:3:20',
			'src/db/stores/aliases.ts:4:20',
			'src/db/stores/aliases.ts:6:23',
			'src/db/stores/aliases.ts:7:23',
			'src/db/stores/notes.ts:1:10',
			'src/db/stores/notes.ts:3:20',
			'src/db/stores/notes.ts:4:20',
		],
		good: {
			'src/db/stores/notes.ts': "export const sqlName = 'notes'\nexport const list = (store: { list(): string[] }) => store.list()\n",
			// A query function takes the declared ctx.sql tag as its parameter, whatever the parameter's name.
			'src/deals/queries.ts': [
				'type Tag = (row: unknown) => (text: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>',
				'declare const Row: unknown',
				'export const pipeline = (sql: Tag, orgId: string) => sql(Row)`select stage from deals where org_id = ${orgId}`',
				'',
			].join('\n'),
			'src/deals/endpoints.ts': [
				'type Tag = (row: unknown) => (text: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>',
				'declare const r: { query(options: object): { handle(handler: (args: { ctx: { sql: Tag } }) => unknown): unknown } }',
				'declare const Row: unknown',
				"export const pipeline = r.query({ sql: 'read' }).handle(async ({ ctx }) => ctx.sql(Row)`select stage from deals where org_id = ${'o1'}`)",
				'',
			].join('\n'),
		},
	},
	{
		rule: 'member-admits-external',
		bad: {
			...CLEAN_APPLICATION,
			'fabrika.contract.ts': CLEAN_CONTRACT.replace(
				"assignableBy: ['owner'] } } },",
				"assignableBy: ['owner'] } }, partner: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] }, external: true } },",
			).replace(
				'\t\tget: c.query(',
				'\t\tme: c.query({ input: null, output: z.strictObject({ ok: z.boolean() }), access: { member: true } }),\n\t\tget: c.query(',
			),
		},
		expected: ['fabrika.contract.ts:5:25'],
		good: {
			...CLEAN_APPLICATION,
			'fabrika.contract.ts': CLEAN_CONTRACT.replace(
				"assignableBy: ['owner'] } } },",
				"assignableBy: ['owner'] } }, partner: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] }, external: true } },",
			),
		},
	},
	{
		rule: 'sql-undeclared',
		bad: {
			'src/deals/endpoints.ts': [
				'type Tag = (row: unknown) => (text: TemplateStringsArray) => Promise<unknown[]>',
				'type Handler = (args: { ctx: { sql: Tag; transaction(work: (tx: { sql: Tag }) => unknown): unknown } }) => unknown',
				'declare const r: { query(options: object): { handle(handler: Handler): unknown }; cron(at: string, options: object): { handle(handler: Handler): unknown } }',
				'declare const Row: unknown',
				'export const group = {',
				'\tpipeline: r.query({ access: {} }).handle(async ({ ctx }) => ctx.sql(Row)`select 1`),',
				"\tclose: r.cron('0 3 * * *', { actions: [] }).handle(async ({ ctx }) => ctx.transaction((tx) => tx.sql(Row)`select 1`)),",
				'\tsatisfied: r.query({ access: {} } satisfies object).handle(async ({ ctx }) => ctx.sql(Row)`select 1`),',
				'\tconstant: r.query({ access: {} } as const).handle(async ({ ctx }) => ctx.sql(Row)`select 1`),',
				'}',
				'',
			].join('\n'),
		},
		expected: ['src/deals/endpoints.ts:6:62', 'src/deals/endpoints.ts:7:96', 'src/deals/endpoints.ts:8:80', 'src/deals/endpoints.ts:9:71'],
		good: {
			'src/deals/endpoints.ts': [
				'type Tag = (row: unknown) => (text: TemplateStringsArray) => Promise<unknown[]>',
				'declare const r: { mutation(options: object): { handle(handler: (args: { ctx: { sql: Tag } }) => unknown): unknown } }',
				'declare const Row: unknown',
				"export const reopen = r.mutation({ access: {}, sql: 'write' }).handle(async ({ ctx }) => ctx.sql(Row)`select 1`)",
				'',
			].join('\n'),
		},
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
		rule: 'framework-write',
		bad: {
			'src/patch.ts': [
				"import { Database, type PostgresOptions } from '@fabrika/db'",
				"import * as implement from '@fabrika/app/implement'",
				"import { z } from 'zod/v4'",
				'',
				'const original = Database.postgres',
				"Reflect.set(Database, 'postgres', (options: PostgresOptions) => original(options))",
				'Database.postgres = original',
				"Object.defineProperty(Database, 'fromDialect', { value: original })",
				'Object.assign(implement.Ref, { check: () => true })',
				'delete z.string',
				'',
			].join('\n'),
		},
		expected: ['src/patch.ts:6:1', 'src/patch.ts:7:1', 'src/patch.ts:8:1', 'src/patch.ts:9:1', 'src/patch.ts:10:1'],
		good: {
			'src/state.ts':
				"import { Database } from '@fabrika/db'\n\nconst opener = { postgres: Database.postgres }\nopener.postgres = Database.postgres\nexport { opener }\n",
			'src/shadow.ts': [
				"import { Ref } from '@fabrika/app/implement'",
				"import { z } from 'zod/v4'",
				'',
				'export const rename = (Ref: { label: string }) => {',
				"\tRef.label = 'renamed'",
				'}',
				'export function count(z: { n: number }) {',
				'\tz.n++',
				'\tfor (const Ref of [{ seen: false }]) Ref.seen = true',
				'\ttry {',
				'\t\tthrow new Error(String(z.n))',
				'\t} catch (Ref) {',
				"\t\tReflect.set(Object(Ref), 'handled', true)",
				'\t}',
				'}',
				'export const local = () => {',
				'\tconst z = { patched: false }',
				'\tz.patched = true',
				'\treturn [z, Ref]',
				'}',
				'',
			].join('\n'),
		},
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
		rule: 'url-endpoint',
		bad: { ...CLEAN_APPLICATION, 'src/links.ts': "export const link = (ctx: { url(id: string): string }) => ctx.url('api.notes.missing')\n" },
		expected: ['src/links.ts:1:59'],
		good: { ...CLEAN_APPLICATION, 'src/links.ts': "export const link = (ctx: { url(id: string): string }) => ctx.url('api.get')\n" },
	},
	{
		rule: 'on-conflict-index',
		bad: {
			...CLEAN_APPLICATION,
			'db/migrations/20261019120000_notes.sql':
				'CREATE TABLE notes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL);\nCREATE INDEX notes_title ON notes (title);\n',
			'src/notes/save.ts': 'export const save = (db: { notes: { insert(row: object, options: object): void } }) =>\n'
				+ "\tdb.notes.insert({ title: 'a' }, { onConflict: { columns: ['title'], do: 'nothing' } })\n",
		},
		expected: ['src/notes/save.ts:2:2'],
		good: {
			...CLEAN_APPLICATION,
			'db/migrations/20261019120000_notes.sql':
				'CREATE TABLE notes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, UNIQUE (workspace_id, title));\n',
			'src/notes/save.ts': 'export const save = (db: { notes: { insert(row: object, options: object): void } }) =>\n'
				+ "\tdb.notes.insert({ title: 'a' }, { onConflict: { columns: ['title', 'workspace_id'], do: 'nothing' } })\n",
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
		rule: 'file-column-migration',
		bad: { ...FILE_COLUMN_APPLICATION, 'db/migrations/20261001000000_notes.sql': `${NOTES_TABLE});\n` },
		expected: ['db/migrations/20261001000000_notes.sql:1:1'],
		good: {
			...FILE_COLUMN_APPLICATION,
			'db/migrations/20261001000000_notes.sql': `${NOTES_TABLE} REFERENCES fabrika_files (id));\nCREATE INDEX notes_picture ON notes (picture);\n`,
		},
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
		rule: 'cloudflare-scan',
		bad: await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024, scan: true })"),
		expected: ['fabrika.contract.ts:1:1'],
		good: await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024 })"),
	},
	{
		rule: 'cloudflare-job-segment',
		bad: await cloudflareApplication(
			"c.files({ types: ['image/png'], maxBytes: 1024 })",
			(contract) => contract.replace(JOB_ACTIONS, `${JOB_ACTIONS}, limits: { timeoutMs: 840001 }`),
		),
		expected: ['fabrika.contract.ts:1:1'],
		good: await cloudflareApplication(
			"c.files({ types: ['image/png'], maxBytes: 1024 })",
			(contract) => contract.replace(JOB_ACTIONS, `${JOB_ACTIONS}, limits: { timeoutMs: 840000 }`),
		),
	},
	{
		rule: 'cloudflare-held-call',
		bad: { ...ARCHITECTURE_APPLICATION, ...DEALS_CREATE_EGRESS, 'fabrika.config.ts': CLOUDFLARE_CONFIG },
		expected: ['fabrika.contract.ts:1:1'],
		good: { ...ARCHITECTURE_APPLICATION, ...DEALS_CREATE_EGRESS },
	},
	{
		rule: 'cloudflare-current-timestamp',
		bad: {
			...(await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024 })")),
			'db/migrations/20261024120000_audit.sql': 'CREATE TABLE audit (\n\tid TEXT PRIMARY KEY,\n\tat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n',
		},
		expected: ['db/migrations/20261024120000_audit.sql:3:1'],
		good: {
			...(await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024 })")),
			'db/migrations/20261024120000_audit.sql':
				"CREATE TABLE audit (\n\tid TEXT PRIMARY KEY,\n\tat TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))\n);\n",
		},
	},
	{
		rule: 'migration-refused',
		bad: {
			...(await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024 })")),
			'db/migrations/20261024120000_codes.sql': [
				'CREATE TABLE codes (id TEXT PRIMARY KEY, code TEXT NOT NULL);',
				"INSERT INTO codes (id, code) SELECT id, load_extension('/tmp/codes.so') FROM notes;",
				'',
			].join('\n'),
		},
		expected: ['db/migrations/20261024120000_codes.sql:2:1'],
		good: {
			...(await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024 })")),
			'db/migrations/20261024120000_codes.sql':
				'CREATE TABLE codes (id TEXT PRIMARY KEY, code TEXT NOT NULL);\nINSERT INTO codes (id, code) SELECT id, lower(hex(randomblob(16))) FROM notes;\n',
		},
	},
	{
		rule: 'backup-schema',
		bad: {
			...(await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024 })")),
			'db/migrations/20261024120000_invoices.sql': [
				'CREATE TABLE invoices (',
				'\tid TEXT PRIMARY KEY,',
				'\tkind TEXT NOT NULL,',
				'\tproforma_id TEXT REFERENCES invoices (id),',
				"\tCHECK (proforma_id IS NULL OR kind = 'invoice')",
				');',
				'',
			].join('\n'),
		},
		expected: ['db/migrations/20261024120000_invoices.sql:1:1'],
		good: {
			...(await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024 })")),
			'db/migrations/20261024120000_invoices.sql': [
				"CREATE TABLE invoices (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('invoice', 'proforma')));",
				'ALTER TABLE invoices ADD COLUMN proforma_id TEXT REFERENCES invoices (id);',
				'',
			].join('\n'),
		},
	},
	{
		rule: 'cloudflare-framework-name',
		bad: {
			...(await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024 })")),
			'db/migrations/20261024120000_leases.sql': [
				'CREATE VIEW leases AS SELECT * FROM fabrika_job_leases;',
				'CREATE TRIGGER wipe AFTER INSERT ON notes BEGIN DELETE FROM [Fabrika_Wakes]; END;',
				"CREATE VIEW kicks AS SELECT * FROM 'fabrika_job_kicks';",
				'CREATE TABLE avatars (id TEXT PRIMARY KEY, file_id TEXT REFERENCES "fabrika_files_avatars" (id));',
				'',
			].join('\n'),
		},
		expected: [
			'db/migrations/20261024120000_leases.sql:1:1',
			'db/migrations/20261024120000_leases.sql:2:1',
			'db/migrations/20261024120000_leases.sql:3:1',
			'db/migrations/20261024120000_leases.sql:4:1',
		],
		good: {
			...(await cloudflareApplication("c.files({ types: ['image/png'], maxBytes: 1024 })")),
			'db/migrations/20261024120000_avatars.sql':
				'CREATE TABLE avatars (\n\tid TEXT PRIMARY KEY,\n\tfile_id TEXT NOT NULL REFERENCES fabrika_files (id)\n);\n',
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
			// An alias imported from bun:test is the alias.
			'src/__tests__/imported.test.ts': "import { expect, xdescribe } from 'bun:test'\n\nxdescribe('notes', () => expect(1).toBe(1))\n",
		},
		expected: [
			'src/__tests__/imported.test.ts:3:1',
			'src/__tests__/notes.test.ts:2:1',
			'src/__tests__/notes.test.ts:3:1',
			'src/__tests__/notes.test.ts:4:1',
			'src/__tests__/notes.test.ts:5:1',
			'src/__tests__/notes.test.ts:6:1',
		],
		good: {
			'src/notes.test.ts': "import { expect, test } from 'bun:test'\n\ntest('lists', () => {\n\texpect([1]).toHaveLength(1)\n})\n",
			// A helper the test file binds itself is not Bun's focused test, whatever its name.
			'src/fit.test.ts': [
				"import { expect, test } from 'bun:test'",
				"import { xit } from './scale'",
				'',
				'const fit = (width: number) => Math.min(width, 80)',
				"test('fits', () => {",
				'\texpect(fit(120)).toBe(80)',
				'\texpect(xit(2)).toBe(4)',
				'})',
				'',
			].join('\n'),
			'src/scale.ts': 'export const xit = (factor: number) => factor * 2\n',
		},
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
	test('the table covers every rule id except generated-test-hash and the architecture rules, which have their own suites', () => {
		expect(new Set([...cases.map((item) => item.rule), 'generated-test-hash', ...STRUCTURE_RULE_IDS])).toEqual(new Set(RULE_IDS))
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

describe('literal: a schema method on an imported literal schema', () => {
	const withStatus = (schemas: string, input: string): Readonly<Record<string, string>> => ({
		...CLEAN_APPLICATION,
		'src/schemas/notes.ts': `${CLEAN_SCHEMAS}export const Status = z.enum(['open', 'done'])\n${schemas}`,
		'fabrika.contract.ts': CLEAN_CONTRACT
			.replace("import { CreateNote, Note } from './src/schemas/notes'", "import { CreateNote, Filter, Note } from './src/schemas/notes'")
			.replace('input: z.strictObject({ id: z.uuid() })', `input: ${input}`),
	})

	test('allowed: .optional(), .nullable() and .array() of a schema const of another module', async () => {
		const files = withStatus(
			'export const Filter = z.strictObject({ status: Status.optional(), any: Status.nullable().array() })\n',
			'z.strictObject({ id: z.uuid(), filter: Filter.optional() })',
		)
		expect(await check(files)).toEqual([])
	})

	test('refused at the offending call only, not again at the import of the const that holds it', async () => {
		const files = withStatus(
			'export const Filter = z.strictObject({ status: Status.transform((value) => value) })\n',
			'z.strictObject({ id: z.uuid(), filter: Filter })',
		)
		expect(locations(await check(files), 'literal')).toEqual(['src/schemas/notes.ts:6:48'])
	})
})

describe('member-admits-external', () => {
	test('names a { member: true } endpoint a human reaches, and not one of a machine-only mount', async () => {
		const external = CLEAN_CONTRACT.replace(
			"assignableBy: ['owner'] } } },",
			"assignableBy: ['owner'] } }, partner: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] }, external: true } },",
		).replace(
			'\t\tget: c.query(',
			'\t\tme: c.query({ input: null, output: z.strictObject({ ok: z.boolean() }), access: { member: true } }),\n\t\tget: c.query(',
		)
		const hints = async (contract: string) =>
			(await check({ ...CLEAN_APPLICATION, 'fabrika.contract.ts': contract })).filter((finding) => finding.rule === 'member-admits-external')
		expect(await hints(external)).toEqual([
			expect.objectContaining({
				severity: 'hint',
				message: "'api.me' admits every member, and external role 'partner' makes a person from outside the organization one",
			}),
		])
		expect(await hints(external.replace("callers: ['human']", "callers: ['machine']"))).toEqual([])
	})
})

describe('sql-undeclared', () => {
	test('is a hint that names the site and the declaration to add', async () => {
		const findings = await check({
			'src/deals/endpoints.ts': [
				'type Tag = (row: unknown) => (text: TemplateStringsArray) => Promise<unknown[]>',
				'declare const r: { mutation(options: object): { handle(handler: (args: { ctx: { sql: Tag } }) => unknown): unknown } }',
				'declare const Row: unknown',
				'export const deals = { reopen: r.mutation({ access: {} }).handle(async ({ ctx }) => ctx.sql(Row)`select 1`) }',
				'',
			].join('\n'),
		})
		expect(findings.filter((finding) => finding.rule === 'sql-undeclared')).toEqual([
			expect.objectContaining({
				severity: 'hint',
				message: "ctx.sql in the handler of 'reopen', whose options declare no sql",
				allowed: "sql: 'read' in the options of 'reopen', or sql: 'write' to write",
			}),
		])
	})
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

	test('a defineTables call of another shape names the form that needs no type arguments', async () => {
		const chained = "import { defineTables } from '@fabrika/db/tables'\n\nexport const tables = defineTables(vocabulary, columns)({})({})\n"
		const findings = await check({ ...CLEAN_APPLICATION, 'src/db/tables.ts': chained })
		expect(findings.filter((finding) => finding.rule === 'literal').map((finding) => finding.allowed)).toEqual([
			'defineTables(vocabulary, columns)({ … })',
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
