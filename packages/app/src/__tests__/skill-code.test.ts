// Every code block of the agent skill is code an agent copies, so each one must work as written. A `ts`, `sql` or `json`
// block names its file after the language (```ts src/tasks/endpoints.ts). The blocks of the base files are one
// application, compiled with the skill's own tsconfig against the workspace's packages; each other reference file is
// compiled over it, its blocks replacing the base's file of the same path. Its migrations are classified as the runner
// classifies them and, on Postgres, migrate to the catalog the generated schema is rendered from.

import { type FileOwner, fileTableSql } from '@fabrika/db'
import { introspectCatalog, renderSchema } from '@fabrika/db/codegen'
import { testDatabase } from '@fabrika/db/testing'
import { classifyMigrations } from '@fabrika/platform-node/sql'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { z } from 'zod/v4'
import { readAppAgentSkill } from '../agent-skill'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
const fixtureDir = join(import.meta.dir, 'skill-app')
/** The template's root resolves the packages its `package.json` names; the application is compiled in a directory under it. */
const templateDir = join(repoRoot, 'examples', 'zerops-app')
const appRoot = join(templateDir, '.skill-app')

/** The files whose blocks are the one application; every other reference file is a variant of it. */
const BASE = ['SKILL.md', 'references/app-setup.md', 'references/table-and-migration.md', 'references/endpoint.md', 'references/tests.md']

/**
 * Files whose diagnostics wait for WU13b: the read-only member directory, and the missing-handler error it cascades into
 * at the mount. Delete this list when WU13b is on main.
 */
const AWAITING_WU13B: readonly string[] = ['fabrika.contract.ts', 'src/members/endpoints.ts']

interface Block {
	readonly file: string
	readonly language: string
	readonly path: string | null
	readonly code: string
}

const FENCE = /^```(\S+)(?: (\S+))?\n([\s\S]*?)^```$/gm

function blocksOf(file: string, text: string): Block[] {
	return [...text.matchAll(FENCE)].map((match) => ({ file, language: match[1] ?? '', path: match[2] ?? null, code: match[3] ?? '' }))
}

const skill = readAppAgentSkill()
const sources = [{ path: 'SKILL.md', text: skill.text }, ...skill.references]
const blocks = sources.flatMap((source) => blocksOf(source.path, source.text))
const checked = blocks.filter((block) => block.language === 'ts' || block.language === 'sql' || block.language === 'json')
const migrations = checked.filter((block) => block.language === 'sql').sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''))

/** What `introspectCatalog` answers, as `catalog.json` holds it. */
const Catalog = z.strictObject({
	columns: z.array(z.strictObject({
		table_name: z.string(),
		column_name: z.string(),
		type_name: z.string(),
		type_type: z.string(),
		type_category: z.string(),
		nullable: z.boolean(),
		generated: z.enum(['no', 'default', 'always']),
		enum_labels: z.array(z.string()),
	})),
	foreignKeys: z.array(z.strictObject({
		table_name: z.string(),
		constraint_name: z.string(),
		columns: z.array(z.string()),
		referenced_table: z.string(),
		referenced_columns: z.array(z.string()),
	})),
})
const fixtureCatalog = Catalog.parse(JSON.parse(readFileSync(join(fixtureDir, 'catalog.json'), 'utf-8')))

/** The generated files of the application: what codegen and `fabrika connect` would write. */
function generatedFiles(): Map<string, string> {
	return new Map([
		['src/db/schema.generated.ts', renderSchema(fixtureCatalog.columns, fixtureCatalog.foreignKeys)],
		['fabrika/connect/catalog.products.v1.ts', readFileSync(join(fixtureDir, 'fabrika', 'connect', 'catalog.products.v1.ts'), 'utf-8')],
	])
}

function filesOf(sourcePaths: readonly string[]): Map<string, string> {
	const files = new Map<string, string>()
	for (const block of checked) {
		if (block.path !== null && sourcePaths.includes(block.file)) files.set(block.path, block.code)
	}
	return files
}

const base = filesOf(BASE)

function compilerOptions(): ts.CompilerOptions {
	const tsconfig = base.get('tsconfig.json')
	if (tsconfig === undefined) throw new Error('the skill shows no tsconfig.json')
	const parsed = z.object({ compilerOptions: z.record(z.string(), z.unknown()) }).parse(JSON.parse(tsconfig))
	const converted = ts.convertCompilerOptionsFromJson(parsed.compilerOptions, appRoot)
	expect(converted.errors).toEqual([])
	return converted.options
}

/** The diagnostics of the application `files` (path → source), one line each: `<path>:<line> <message>`. */
function compile(files: ReadonlyMap<string, string>): string[] {
	const options = compilerOptions()
	const virtual = new Map([...generatedFiles(), ...files].map(([path, code]) => [join(appRoot, path), code]))
	const host = ts.createCompilerHost(options)
	const readFile = host.readFile.bind(host)
	const fileExists = host.fileExists.bind(host)
	const directoryExists = host.directoryExists?.bind(host)
	const getSourceFile = host.getSourceFile.bind(host)
	const isVirtualDirectory = (path: string): boolean => [...virtual.keys()].some((file) => file.startsWith(`${path}/`))
	host.readFile = (path) => virtual.get(path) ?? readFile(path)
	host.fileExists = (path) => virtual.has(path) || fileExists(path)
	host.directoryExists = (path) => isVirtualDirectory(path) || (directoryExists?.(path) ?? true)
	host.getCurrentDirectory = () => appRoot
	host.getSourceFile = (path, language, onError, create) => {
		const code = virtual.get(path)
		return code === undefined ? getSourceFile(path, language, onError, create) : ts.createSourceFile(path, code, language)
	}
	const roots = [...virtual.keys()].filter((path) => path.endsWith('.ts'))
	const program = ts.createProgram(roots, { ...options, noEmit: true }, host)
	return ts.getPreEmitDiagnostics(program).flatMap((diagnostic) => {
		const file = diagnostic.file?.fileName ?? ''
		const relative = file.startsWith(`${appRoot}/`) ? file.slice(appRoot.length + 1) : file
		if (AWAITING_WU13B.includes(relative)) return []
		const line = diagnostic.file === undefined || diagnostic.start === undefined
			? 0
			: diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
		return [`${relative}:${line} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`]
	})
}

describe('the code blocks of the agent skill', () => {
	test('every ts, sql and json block names the file it is', () => {
		expect(checked.filter((block) => block.path === null).map((block) => `${block.file}: ${block.code.split('\n')[0]}`)).toEqual([])
	})

	test('a base file is shown once, and a variant once per reference file', () => {
		const seen = (files: readonly string[]) => checked.filter((block) => files.includes(block.file)).map((block) => block.path)
		const repeated = (paths: readonly (string | null)[]) => paths.filter((path, index) => paths.indexOf(path) !== index)
		expect(repeated(seen(BASE))).toEqual([])
		for (const source of sources) expect(repeated(seen([source.path]))).toEqual([])
	})

	test('the application compiles clean', () => {
		expect(compile(base)).toEqual([])
	}, 120_000)

	for (const source of sources.filter((source) => !BASE.includes(source.path) && filesOf([source.path]).size > 0)) {
		test(`${source.path} compiles clean over the application`, () => {
			const files = new Map([...base, ...filesOf([source.path])])
			expect(compile(files)).toEqual([])
		}, 120_000)
	}

	test('package.json depends on what the template depends on', () => {
		const Manifest = z.object({ dependencies: z.record(z.string(), z.string()), devDependencies: z.record(z.string(), z.string()) })
		const shown = Manifest.parse(JSON.parse(base.get('package.json') ?? '{}'))
		const template = Manifest.parse(JSON.parse(readFileSync(join(templateDir, 'package.json'), 'utf-8')))
		expect(shown.dependencies).toEqual(template.dependencies)
		expect(shown.devDependencies).toEqual(template.devDependencies)
	})

	test('the migrations are named as the checker requires and the runner refuses none of them', () => {
		expect(migrations.map((block) => block.path).filter((path) => !/^db\/migrations\/\d{14}_[a-z0-9_]+\.sql$/.test(path ?? ''))).toEqual([])
		const classified = classifyMigrations(migrations.map((block) => ({ name: block.path ?? '', sql: block.code })), 'app_tasks')
		expect(classified.files.flatMap((file) => file.refused.map((refusal) => `${file.file}: ${refusal.message}`))).toEqual([])
	})

	test("the file collection's migration is what fileTableSql writes", () => {
		const attachments = migrations.find((block) => block.path === 'db/migrations/20261012100000_attachments.sql')
		const owner: FileOwner = {
			table: 'tasks',
			key: { column: 'id', type: 'uuid' },
			chain: [{ column: 'project_id', type: 'uuid' }, { column: 'org_id', type: 'text' }],
		}
		expect(attachments?.code).toBe(fileTableSql('attachments', owner))
	})

	test('the migrations migrate to the catalog the generated schema is rendered from', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'fabrika-skill-migrations-'))
		for (const block of migrations) writeFileSync(join(directory, basename(block.path ?? '')), block.code)
		const postgres = await testDatabase({ migrations: pathToFileURL(`${directory}/`), label: 'skill-code.test.ts' })
		if (postgres === null) {
			rmSync(directory, { recursive: true })
			return
		}
		try {
			const classified = classifyMigrations(migrations.map((block) => ({ name: block.path ?? '', sql: block.code })), postgres.schema)
			const catalog = await introspectCatalog(process.env['FABRIKA_TEST_POSTGRES_URL'] ?? '', postgres.schema, classified.objects)
			expect(catalog).toEqual(fixtureCatalog)
		} finally {
			await postgres.close()
			rmSync(directory, { recursive: true })
		}
	}, 60_000)
})
