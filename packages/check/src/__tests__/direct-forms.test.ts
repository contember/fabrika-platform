import { describe, expect, test } from 'bun:test'
import type { RuleId } from '../finding'
import { generatedTestHeader } from '../rules/tests'
import { check, CLEAN_APPLICATION, CLEAN_CONTRACT, locations } from './helpers'

/** A form written out directly; D11 accepts that aliased or indirect forms escape, but these must not. */
interface DirectForm {
	readonly name: string
	readonly rule: RuleId
	readonly files: Readonly<Record<string, string>>
	readonly expected: readonly string[]
}

const contractWith = (search: string, replacement: string): string => {
	if (!CLEAN_CONTRACT.includes(search)) throw new Error(`the clean contract has no '${search}'`)
	return CLEAN_CONTRACT.replace(search, replacement)
}

const ZEROPS_YAML = (entry: string) => `zerops:\n  - setup: app\n    run:\n      start: bun server.ts\n      crontab:\n${entry}`

const refused: readonly DirectForm[] = [
	{
		name: 'schema callbacks: overwrite and check',
		rule: 'literal',
		files: {
			...CLEAN_APPLICATION,
			'src/schemas/extra.ts': "import { z } from 'zod/v4'\n\n"
				+ 'export const Trimmed = z.string().overwrite((value) => value.trim())\n'
				+ "export const Checked = z.string().check((ctx) => ctx.issues.push({ code: 'custom', input: '', message: 'no' }))\n",
			'fabrika.contract.ts': contractWith(
				"import { CreateNote, Note } from './src/schemas/notes'",
				"import { CreateNote, Note } from './src/schemas/notes'\nimport { Checked, Trimmed } from './src/schemas/extra'\nexport const extra = [Checked, Trimmed]",
			),
		},
		expected: ['fabrika.contract.ts:4:10', 'fabrika.contract.ts:4:19', 'src/schemas/extra.ts:3:24', 'src/schemas/extra.ts:4:24'],
	},
	{
		name: 'a function outside a builder-callback position',
		rule: 'literal',
		files: { 'fabrika.contract.ts': 'export const contract = { app: (value: string) => value.trim() }\n' },
		expected: ['fabrika.contract.ts:1:32'],
	},
	{
		name: 'an imported surface callback',
		rule: 'literal',
		files: {
			'fabrika.contract.ts': "import { defineContract } from '@fabrika/app/contract'\nimport { surface } from './src/surface'\n\n"
				+ "export const contract = defineContract({ app: 'notes' }, surface)\n",
			'src/surface.ts': "export const surface = (c: { health(path: string): unknown }) => ({ health: c.health('/healthz') })\n",
		},
		expected: ['fabrika.contract.ts:2:10', 'fabrika.contract.ts:4:58', 'src/surface.ts:1:24'],
	},
	{
		name: 'z.object and a schema operation that computes a value',
		rule: 'literal',
		files: {
			'fabrika.contract.ts':
				"import { z } from 'zod/v4'\n\nexport const Loose = z.object({ title: z.string() })\nexport const name = z.string().parse('notes')\n",
		},
		expected: ['fabrika.contract.ts:3:22', 'fabrika.contract.ts:4:21'],
	},
	{
		name: 'an exported import of an uninspected package, and an unused one',
		rule: 'literal',
		files: { 'fabrika.contract.ts': "import { contract } from 'some-contract'\nimport { pick } from 'lodash'\n\nexport { contract }\n" },
		expected: ['fabrika.contract.ts:1:10', 'fabrika.contract.ts:2:10'],
	},
	{
		name: 'a const defined through itself, in one module and across two',
		rule: 'literal',
		files: {
			'fabrika.contract.ts': "import { left } from './src/left'\n\nconst a = b\nconst b = a\nexport const contract = { app: a, other: left }\n",
			'src/left.ts': "import { right } from './right'\n\nexport const left = right\n",
			'src/right.ts': "import { left } from './left'\n\nexport const right = left\n",
		},
		expected: ['fabrika.contract.ts:1:10', 'fabrika.contract.ts:3:7', 'src/left.ts:1:10', 'src/left.ts:3:14', 'src/right.ts:1:10'],
	},
	{
		name: 'an import of a const the module does not export',
		rule: 'literal',
		files: {
			'fabrika.contract.ts': "import { hidden } from './src/values'\n\nexport const contract = { app: hidden }\n",
			'src/values.ts': "const hidden = 'notes'\nexport const shown = hidden\n",
		},
		expected: ['fabrika.contract.ts:1:10'],
	},
	{
		name: 'absolute and file-URL imports',
		rule: 'unchecked-import',
		files: { 'src/a.ts': "import { serve } from '/tmp/outside/serve.ts'\nimport 'file:///tmp/outside/other.ts'\nexport { serve }\n" },
		expected: ['src/a.ts:1:1', 'src/a.ts:2:1'],
	},
	{
		name: 'a package import map and a tsconfig path into a skipped directory',
		rule: 'unchecked-import',
		files: {
			'package.json': '{ "name": "notes", "imports": { "#hidden": "./.hidden/serve.ts" } }\n',
			'tsconfig.json': '{\n\t// paths are read like Bun reads them\n\t"compilerOptions": { "paths": { "@hidden/*": ["./.hidden/*"] } },\n}\n',
			'src/a.ts': "import '#hidden'\nimport '@hidden/serve'\n",
		},
		expected: ['src/a.ts:1:1', 'src/a.ts:2:1'],
	},
	{
		name: 'members of a direct load of bun',
		rule: 'forbidden-global',
		files: {
			'src/server.ts': "require('bun').serve({})\nexport const server = (await import('bun')).serve({})\nexport { serve } from 'bun'\n"
				+ "export const bucket = new Bun.S3Client({})\nimport { S3Client } from 'bun'\nexport { S3Client }\n"
				+ 'export const tick = Bun[`serve`]({})\n',
		},
		expected: ['src/server.ts:1:1', 'src/server.ts:2:30', 'src/server.ts:3:1', 'src/server.ts:4:27', 'src/server.ts:5:1', 'src/server.ts:7:21'],
	},
	{
		name: 'the environment through a direct load, a re-export and a template key',
		rule: 'env-read',
		files: {
			'src/config.ts': "export const a = require('node:process').env.SECRET\nexport const b = (await import('node:process')).env.SECRET\n"
				+ "export { env } from 'node:process'\nexport const c = process[`env`][`SECRET`]\n",
		},
		expected: ['src/config.ts:1:18', 'src/config.ts:2:25', 'src/config.ts:3:1', 'src/config.ts:4:18'],
	},
	{
		name: 'template specifiers, module.require and aws-sdk',
		rule: 'forbidden-import',
		files: {
			'src/data.ts': 'export const a = require(`pg`)\nexport const b = import(`jose`)\n'
				+ "export const c = module.require('pg')\nexport const d = module['require']('pg')\nimport AWS from 'aws-sdk'\nexport { AWS }\n",
		},
		expected: ['src/data.ts:1:18', 'src/data.ts:2:18', 'src/data.ts:3:18', 'src/data.ts:4:18', 'src/data.ts:5:1'],
	},
	{
		name: 'qualified eval and Function through call and apply',
		rule: 'dynamic-code',
		files: {
			'src/run.ts': "globalThis.eval('alert(1)')\nwindow['eval']('alert(1)')\nFunction.call(null, 'return 1')\nFunction.apply(null, ['return 1'])\n",
		},
		expected: ['src/run.ts:1:1', 'src/run.ts:2:1', 'src/run.ts:3:1', 'src/run.ts:4:1'],
	},
	{
		name: 'constructed errors, requests and headers, and wrapped error objects',
		rule: 'sensitive-log',
		files: {
			'src/log.ts': [
				"console.error(new Error('secret'))",
				"console.log(new Request('https://example.com'))",
				"console.log(new Headers({ Authorization: 'secret' }))",
				'try {',
				'\tawait Promise.resolve()',
				'} catch (failure) {',
				'\tconsole.log(failure ?? null)',
				'\tconsole.log(failure ? failure : null)',
				'\tconsole.log(`failed: ${failure}`)',
				'}',
				'',
			].join('\n'),
		},
		expected: ['src/log.ts:1:15', 'src/log.ts:2:13', 'src/log.ts:3:13', 'src/log.ts:7:14', 'src/log.ts:8:24', 'src/log.ts:9:25'],
	},
	{
		name: 'delete on a prototype and a mutation of Object.getPrototypeOf',
		rule: 'prototype-assignment',
		files: {
			'src/patch.ts': "import { Ref } from '@fabrika/app'\n\ndeclare const ref: object\ndelete Ref.prototype.check\n"
				+ 'Object.assign(Object.getPrototypeOf(ref), { check: () => true })\n',
		},
		expected: ['src/patch.ts:4:1', 'src/patch.ts:5:1'],
	},
	{
		name: 'a concatenated origin, fetch.call and fetch.apply',
		rule: 'cross-app-fetch',
		files: {
			'src/sync.ts': "export const a = fetch('https://' + 'other.example/api')\n"
				+ "export const b = fetch.call(globalThis, 'https://other.example/api')\n"
				+ "export const c = fetch.apply(globalThis, ['https://other.example/api'])\n",
		},
		expected: ['src/sync.ts:1:18', 'src/sync.ts:2:18', 'src/sync.ts:3:18'],
	},
	{
		name: 'a sql helper through a namespace and a direct load',
		rule: 'raw-sql',
		files: {
			'src/db.ts': 'export const sql = { raw: (text: string) => text }\n',
			'src/query.ts': "import * as db from './db'\n\nexport const a = db.sql.raw('select 1')\nexport const b = require('./db').sql.raw('select 1')\n",
		},
		expected: ['src/query.ts:3:18', 'src/query.ts:4:18'],
	},
	{
		name: 'an escaped key prefix in a template, and a key in JSON',
		rule: 'key-literal',
		files: { 'src/a.ts': 'export const key = `p\\x78_live`\n', 'src/settings.json': '{ "token": "px_live_secret" }\n' },
		expected: ['src/a.ts:1:21', 'src/settings.json:1:12'],
	},
	{
		name: 'Ref and Within with a union containing string',
		rule: 'capability-widening',
		files: {
			'src/a.ts':
				"import type { Ref, Within } from '@fabrika/app'\n\nexport type A = Ref<string | 'note', 'notes.read'>\nexport type B = Within<'workspace', 'a' | string>\n",
		},
		expected: ['src/a.ts:3:17', 'src/a.ts:4:17'],
	},
	{
		name: 'concurrent and parameterized tests without assertions',
		rule: 'test-without-assertion',
		files: { 'src/a.test.ts': "import { test } from 'bun:test'\n\ntest.concurrent('empty', () => {})\ntest.each([1, 2])('empty %d', (n) => {})\n" },
		expected: ['src/a.test.ts:3:1', 'src/a.test.ts:4:1'],
	},
	{
		name: 'expect without a matcher, and an assertion in a function nobody calls',
		rule: 'test-without-assertion',
		files: {
			'src/a.test.ts': "import { expect, test } from 'bun:test'\n\ntest('empty', () => expect(false))\n"
				+ "test('unused', () => {\n\tconst unused = () => expect(false).toBe(true)\n})\n",
		},
		expected: ['src/a.test.ts:3:1', 'src/a.test.ts:4:1'],
	},
	{
		name: 'endpoint inputs through satisfies, a const shape and imported options',
		rule: 'client-identity',
		files: {
			...CLEAN_APPLICATION,
			'src/endpoints.ts': "import { z } from 'zod/v4'\nimport { Note } from './schemas/notes'\n\n"
				+ "export const ListOptions = { input: z.strictObject({ ownerId: z.uuid() }), output: Note, access: { action: 'notes.read', over: 'workspace' } }\n",
			'fabrika.contract.ts': contractWith(
				"\tapi: c.rpc('/api', { callers: ['human'] }, {",
				"\tapi: c.rpc('/api', { callers: ['human'] }, {\n"
					+ '\t\tmine: c.query({ input: z.strictObject({ userId: z.uuid() }) satisfies object, output: Note, access: { member: true } }),\n'
					+ '\t\ttheirs: c.query({ input: z.strictObject(shape), output: Note, access: { member: true } }),\n'
					+ '\t\tlist: c.query(ListOptions),',
			).replace(
				"import { CreateNote, Note } from './src/schemas/notes'",
				"import { CreateNote, Note } from './src/schemas/notes'\nimport { ListOptions } from './src/endpoints'\n\nconst shape = { tenantId: z.string() }",
			),
		},
		expected: ['fabrika.contract.ts:15:26', 'fabrika.contract.ts:16:28', 'fabrika.contract.ts:17:17'],
	},
	{
		name: 'a crontab entry without timing, and a job wrapped in satisfies',
		rule: 'crontab',
		files: {
			...CLEAN_APPLICATION,
			'fabrika.contract.ts': contractWith(
				"\tpurgeDeleted: c.cron('0 3 * * *', { actions: ['notes.write'], scope: 'app' }),",
				"\tpurgeDeleted: c.cron(nightly, { actions: ['notes.write'], scope: 'app' }),\n\tdigest: c.cron('0 7 * * 1', { actions: ['notes.read'], scope: 'app' }) satisfies object,",
			).replace('export const contract', "const nightly = '0 3 * * *'\nexport const contract"),
			'zerops.yaml': ZEROPS_YAML('        - command: fabrika job run purgeDeleted\n          allContainers: false\n'),
		},
		expected: ['zerops.yaml:5:1', 'zerops.yaml:6:1'],
	},
	{
		name: 'a generated-test header moved off the first line',
		rule: 'generated-test-hash',
		files: { 'src/db/__tests__/notes.isolation.test.ts': '' },
		expected: ['src/db/__tests__/notes.isolation.test.ts:2:1'],
	},
]

const body = "import { expect, test } from 'bun:test'\n\ntest('w2 is 404 for w1', () => {\n\texpect(404).toBe(404)\n})\n"

const withGeneratedHeader = async (files: Readonly<Record<string, string>>): Promise<Readonly<Record<string, string>>> => {
	const path = 'src/db/__tests__/notes.isolation.test.ts'
	if (files[path] === undefined) return files
	const weakened = body.replace('expect(404).toBe(404)', 'expect(true).toBe(true)')
	return { ...files, [path]: `\n${await generatedTestHeader(body)}\n${weakened}` }
}

describe('directly spelled forms are refused', () => {
	for (const form of refused) {
		test(`${form.rule}: ${form.name}`, async () => {
			expect(locations(await check(await withGeneratedHeader(form.files)), form.rule)).toEqual([...form.expected])
		})
	}
})

describe('allowed forms the rules must not refuse', () => {
	test('a regex literal in .regex(), a const schedule, a const access, index and .mts modules, and export aliases', async () => {
		const files = {
			...CLEAN_APPLICATION,
			'src/schemas/slug.mts': "import { z } from 'zod/v4'\n\nexport const Slug = z.string().regex(/^[a-z-]+$/)\n",
			'src/shapes/index.mts': "const original = { title: 'notes' }\nexport { original as Title }\n",
			'fabrika.contract.ts': contractWith(
				"access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' }",
				'access: InWorkspace',
			).replace(
				"\tpurgeDeleted: c.cron('0 3 * * *',",
				'\tpurgeDeleted: c.cron(nightly,',
			).replace(
				'export const contract',
				"import { Slug } from './src/schemas/slug'\nimport { Title } from './src/shapes'\n\nconst nightly = `0 3 * * *`\n"
					+ "const InWorkspace = { action: 'notes.write', in: 'workspace', from: 'workspaceId' } as const\nexport const extras = [Slug, Title]\n"
					+ 'export const contract',
			),
			'zerops.yaml': ZEROPS_YAML("        - timing: '0 3 * * *'\n          command: fabrika job run purgeDeleted\n          allContainers: false\n"),
			'src/settings.json': '{ "origin": "https://notes.example" }\n',
			'src/a.test.ts': "import { expect, test } from 'bun:test'\n\ntest('maps', async () => {\n"
				+ '\tawait Promise.all([1].map(async (n) => {\n\t\texpect(n).toBe(1)\n\t}))\n})\n',
			'src/types.ts': "export { type Selectable } from 'kysely'\n",
			'package.json': '{ "imports": { "#lib": "./src/lib.ts" } }\n',
			'src/lib.ts': "export const origin = '/'\n",
			'src/main.ts': "import { origin } from '#lib'\nexport { origin }\n",
		}
		expect(await check(files)).toEqual([])
	})
})

/** Accepted D11 limitations: aliased or indirect forms escape, and the runtime checks stay the boundary. A fix makes these fail. */
describe('documented escapes', () => {
	const escapes: Readonly<Record<string, Readonly<Record<string, string>>>> = {
		'test registrations in a helper module imported by a test': {
			'tests/example.test.ts': "import './cases'\n",
			'tests/cases.ts': "import { expect, test } from 'bun:test'\n\ntest.skip('later', () => expect(1).toBe(1))\n",
		},
		'a global reached through a computed member and destructured': {
			'src/a.ts': "const { serve } = globalThis['Bun']\nconst { env } = globalThis['process']\nexport { env, serve }\n",
		},
		'an alias of fetch': { 'src/a.ts': "const f = fetch\nexport const call = () => f('https://other.example/api')\n" },
		'a renamed capability type': { 'src/a.ts': "import type { Ref as R } from '@fabrika/app'\n\nexport type Wide = R<string, string>\n" },
		'a namespace alias of the test API': {
			'src/a.test.ts': "import * as tests from 'bun:test'\n\ntests.test.skip('empty', () => {})\n",
		},
	}
	for (const [name, files] of Object.entries(escapes)) {
		test(name, async () => {
			expect(await check(files)).toEqual([])
		})
	}
})
