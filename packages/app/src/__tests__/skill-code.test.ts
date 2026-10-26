// Every code block of the agent skill is code an agent copies, so each one must work as written. A `ts`, `tsx`, `sql` or
// `json` block names its file after the language (```ts src/tasks/endpoints.ts). The blocks of the base files are one
// application, compiled with the skill's own tsconfig against the workspace's packages; each other reference file is
// compiled over it, its blocks replacing the base's file of the same path, except a standalone one, which is an
// application of its own over the base's shared files. Each application's migrations are classified as the runner
// classifies them and, on Postgres, migrate to the catalog its generated schema is rendered from.

import { checkApplication, formatFinding } from '@fabrika/check'
import { introspectCatalog, renderSchema } from '@fabrika/db/codegen'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { testDatabase } from '@fabrika/db/testing'
import { classifyMigrations } from '@fabrika/platform-node/sql'
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { z } from 'zod/v4'
import { readAppAgentSkill } from '../agent-skill'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
const fixtureDir = join(import.meta.dir, 'skill-app')
/** The template's root resolves the packages its `package.json` names; the application is compiled in a directory under it. */
const templateDir = join(repoRoot, 'examples', 'zerops-app')
const appRoot = join(templateDir, '.skill-app')

/** The files whose blocks are the one application; every other reference file is a variant of it, or standalone. */
const BASE = ['SKILL.md', 'references/app-setup.md', 'references/table-and-migration.md', 'references/endpoint.md', 'references/tests.md']
/**
 * The section of a base file that is an application of its own, read as the source `CLOUDFLARE.source`: a Cloudflare
 * application's config, which the Zerops template cannot resolve.
 */
const CLOUDFLARE = { file: 'references/app-setup.md', heading: '## The deploy surface (Cloudflare)', source: 'references/app-setup.md (Cloudflare)' }

interface Standalone {
	/** The directory of `skill-app/` that holds its catalog, `null` for one without tables. */
	readonly catalog: string | null
	/** The base's files it uses as they are. */
	readonly shared: readonly string[]
	readonly run?: true
	/** The template under `examples/` whose packages it resolves: `zerops-app` by default. */
	readonly template?: string
	/** It imports oblaka's raw TypeScript, compiled with the two flags the root CLAUDE.md relaxes for it. */
	readonly oblaka?: true
}

/** A reference file, or the Cloudflare section, that is an application of its own. */
const STANDALONE: Readonly<Record<string, Standalone>> = {
	'references/public-intake.md': { catalog: 'public-intake', shared: ['package.json', 'tsconfig.json', 'src/app-kit.ts'], run: true },
	'references/start.md': { catalog: null, shared: ['package.json', 'tsconfig.json'] },
	[CLOUDFLARE.source]: { catalog: null, shared: [], template: 'app', oblaka: true },
}

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

/** `source` without the Cloudflare section, and the section as a source of its own. */
function splitCloudflare(source: { readonly path: string; readonly text: string }): { readonly path: string; readonly text: string }[] {
	if (source.path !== CLOUDFLARE.file) return [source]
	const start = source.text.indexOf(`\n${CLOUDFLARE.heading}\n`)
	if (start < 0) throw new Error(`${CLOUDFLARE.file} has no section ${CLOUDFLARE.heading}`)
	const next = source.text.indexOf('\n## ', start + 1)
	const end = next < 0 ? source.text.length : next
	return [
		{ path: source.path, text: source.text.slice(0, start) + source.text.slice(end) },
		{ path: CLOUDFLARE.source, text: source.text.slice(start, end) },
	]
}

const skill = readAppAgentSkill()
const sources = [{ path: 'SKILL.md', text: skill.text }, ...skill.references].flatMap(splitCloudflare)
const blocks = sources.flatMap((source) => blocksOf(source.path, source.text))
const CHECKED_LANGUAGES: readonly string[] = ['ts', 'tsx', 'sql', 'json']
const checked = blocks.filter((block) => CHECKED_LANGUAGES.includes(block.language))

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
type Catalog = z.infer<typeof Catalog>

const catalogOf = (directory: string): Catalog => Catalog.parse(JSON.parse(readFileSync(join(directory, 'catalog.json'), 'utf-8')))

/** One application of the skill: the files its blocks come from, its catalog, and what `fabrika connect` wrote for it. */
interface SkillApp {
	readonly name: string
	readonly sources: readonly string[]
	readonly schema: string
	/** `null` for an application without tables: no migration and no generated schema. */
	readonly catalog: Catalog | null
	readonly shared: readonly string[]
	readonly vendored: ReadonlyMap<string, string>
	/** The directory it is compiled and checked in, under the template whose packages it resolves. */
	readonly root: string
	readonly oblaka: boolean
}

const standalone = Object.keys(STANDALONE)
const variants = sources.map((source) => source.path).filter((path) => !standalone.includes(path))
const apps: readonly SkillApp[] = [
	{
		name: 'the application',
		sources: variants,
		schema: 'app_tasks',
		catalog: catalogOf(fixtureDir),
		shared: [],
		vendored: new Map([
			['fabrika/connect/catalog.products.v1.ts', readFileSync(join(fixtureDir, 'fabrika', 'connect', 'catalog.products.v1.ts'), 'utf-8')],
		]),
		root: appRoot,
		oblaka: false,
	},
	...Object.entries(STANDALONE).map(([path, { catalog, shared, template, oblaka }]) => ({
		name: path,
		sources: [path],
		schema: `app_${(catalog ?? 'tableless').replaceAll('-', '_')}`,
		catalog: catalog === null ? null : catalogOf(join(fixtureDir, catalog)),
		shared,
		vendored: new Map<string, string>(),
		root: template === undefined ? appRoot : join(repoRoot, 'examples', template, '.skill-app'),
		oblaka: oblaka === true,
	})),
]

/** An application's migrations, in the order the runner applies them. */
const migrationsOf = (app: SkillApp): Block[] =>
	checked.filter((block) => block.language === 'sql' && app.sources.includes(block.file)).sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''))

/** The generated files of an application: what codegen and `fabrika connect` would write. */
function generatedFiles(app: SkillApp): Map<string, string> {
	const generated = new Map(app.vendored)
	if (app.catalog !== null) generated.set('src/db/schema.generated.ts', renderSchema(app.catalog.columns, app.catalog.foreignKeys))
	return generated
}

function filesOf(sourcePaths: readonly string[]): Map<string, string> {
	const files = new Map<string, string>()
	for (const block of checked) {
		if (block.path !== null && sourcePaths.includes(block.file)) files.set(block.path, block.code)
	}
	return files
}

const base = filesOf(BASE)

function compilerOptions(app: SkillApp): ts.CompilerOptions {
	const tsconfig = base.get('tsconfig.json')
	if (tsconfig === undefined) throw new Error('the skill shows no tsconfig.json')
	const parsed = z.object({ compilerOptions: z.record(z.string(), z.unknown()) }).parse(JSON.parse(tsconfig))
	const converted = ts.convertCompilerOptionsFromJson(parsed.compilerOptions, app.root)
	expect(converted.errors).toEqual([])
	return app.oblaka ? { ...converted.options, noUncheckedIndexedAccess: false, noPropertyAccessFromIndexSignature: false } : converted.options
}

/** The diagnostics of `app`'s `files` (path → source), one line each: `<path>:<line> <message>`. */
function compile(app: SkillApp, files: ReadonlyMap<string, string>): string[] {
	const options = compilerOptions(app)
	const virtual = new Map([...generatedFiles(app), ...files].map(([path, code]) => [join(app.root, path), code]))
	const host = ts.createCompilerHost(options)
	const readFile = host.readFile.bind(host)
	const fileExists = host.fileExists.bind(host)
	const directoryExists = host.directoryExists?.bind(host)
	const getSourceFile = host.getSourceFile.bind(host)
	const isVirtualDirectory = (path: string): boolean => [...virtual.keys()].some((file) => file.startsWith(`${path}/`))
	host.readFile = (path) => virtual.get(path) ?? readFile(path)
	host.fileExists = (path) => virtual.has(path) || fileExists(path)
	host.directoryExists = (path) => isVirtualDirectory(path) || (directoryExists?.(path) ?? true)
	host.getCurrentDirectory = () => app.root
	host.getSourceFile = (path, language, onError, create) => {
		const code = virtual.get(path)
		return code === undefined ? getSourceFile(path, language, onError, create) : ts.createSourceFile(path, code, language)
	}
	const roots = [...virtual.keys()].filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'))
	const program = ts.createProgram(roots, { ...options, noEmit: true }, host)
	return ts.getPreEmitDiagnostics(program).flatMap((diagnostic) => {
		const file = diagnostic.file?.fileName ?? ''
		const relative = file.startsWith(`${app.root}/`) ? file.slice(app.root.length + 1) : file
		const line = diagnostic.file === undefined || diagnostic.start === undefined
			? 0
			: diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
		return [`${relative}:${line} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`]
	})
}

describe('the code blocks of the agent skill', () => {
	test('every ts, tsx, sql and json block names the file it is', () => {
		expect(checked.filter((block) => block.path === null).map((block) => `${block.file}: ${block.code.split('\n')[0]}`)).toEqual([])
	})

	test('a base file is shown once, and a variant once per reference file', () => {
		const seen = (files: readonly string[]) => checked.filter((block) => files.includes(block.file)).map((block) => block.path)
		const repeated = (paths: readonly (string | null)[]) => paths.filter((path, index) => paths.indexOf(path) !== index)
		expect(repeated(seen(BASE))).toEqual([])
		for (const source of sources) expect(repeated(seen([source.path]))).toEqual([])
	})

	const [application, ...others] = apps
	if (application === undefined) throw new Error('the skill has no base application')

	test('the application compiles clean', () => {
		expect(compile(application, base)).toEqual([])
	}, 120_000)

	for (const source of sources.filter((source) => variants.includes(source.path) && !BASE.includes(source.path) && filesOf([source.path]).size > 0)) {
		test(`${source.path} compiles clean over the application`, () => {
			const files = new Map([...base, ...filesOf([source.path])])
			expect(compile(application, files)).toEqual([])
		}, 120_000)
	}

	for (const app of others) {
		test(`${app.name} compiles clean as an application of its own`, () => {
			const shared = [...base].filter(([path]) => app.shared.includes(path))
			expect(compile(app, new Map([...shared, ...filesOf(app.sources)]))).toEqual([])
		}, 120_000)
	}

	// An agent that copies a recipe runs fabrika-check next: a recipe the checker refuses, or hints at, teaches the wrong
	// form. The skill shows no generated test; `fabrika db test-scaffold` writes them. The base application and each
	// variant show their own slices, not one contract and one migration history that compose every reference file, so
	// over them the rules of the whole application are left out.
	const WHOLE_APPLICATION_RULES: readonly string[] = ['contract', 'file-column-migration']
	const checkerFindings = async (app: SkillApp, files: ReadonlyMap<string, string>, skipped: readonly string[] = []): Promise<string[]> => {
		const findings = await checkApplication({ root: app.root, files: new Map([...generatedFiles(app), ...files]) })
		return findings.filter((finding) => finding.rule !== 'generated-test-hash' && !skipped.includes(finding.rule)).map(formatFinding)
	}

	test('the checker finds nothing in the application', async () => {
		expect(await checkerFindings(application, base, WHOLE_APPLICATION_RULES)).toEqual([])
	}, 120_000)

	for (const source of sources.filter((source) => variants.includes(source.path) && !BASE.includes(source.path) && filesOf([source.path]).size > 0)) {
		test(`the checker finds nothing in ${source.path} over the application`, async () => {
			expect(await checkerFindings(application, new Map([...base, ...filesOf([source.path])]), WHOLE_APPLICATION_RULES)).toEqual([])
		}, 120_000)
	}

	for (const app of others) {
		test(`the checker finds nothing in ${app.name}`, async () => {
			const shared = [...base].filter(([path]) => app.shared.includes(path))
			expect(await checkerFindings(app, new Map([...shared, ...filesOf(app.sources)]))).toEqual([])
		}, 120_000)
	}

	// A recipe whose tests prove what it promises runs them: its files are written under the template, whose
	// node_modules resolve the workspace's packages, and `bun test` runs there on a throwaway schema.
	for (const app of others.filter((app) => STANDALONE[app.name]?.run === true)) {
		test(`${app.name}: its own tests pass on Postgres`, () => {
			if ((process.env['FABRIKA_TEST_POSTGRES_URL'] ?? '') === '') {
				console.warn(`skill-code.test.ts did not run the tests of ${app.name}: set FABRIKA_TEST_POSTGRES_URL`)
				return
			}
			const directory = mkdtempSync(join(templateDir, '.skill-run-'))
			try {
				const shared = [...base].filter(([path]) => app.shared.includes(path))
				for (const [path, code] of [...generatedFiles(app), ...shared, ...filesOf(app.sources)]) {
					mkdirSync(dirname(join(directory, path)), { recursive: true })
					writeFileSync(join(directory, path), code)
				}
				const run = Bun.spawnSync(['bun', 'test', '--isolate', 'src/'], {
					cwd: directory,
					env: { ...process.env, FABRIKA_TEST_POSTGRES_REQUIRED: '1' },
				})
				const output = `${run.stdout.toString()}${run.stderr.toString()}`
				if (run.exitCode !== 0) console.error(output)
				expect({ exitCode: run.exitCode, failed: / [1-9]\d* fail/.test(output), passed: / [1-9]\d* pass/.test(output) }).toEqual({
					exitCode: 0,
					failed: false,
					passed: true,
				})
			} finally {
				rmSync(directory, { recursive: true })
			}
		}, 120_000)
	}

	test('package.json depends on what the template depends on', () => {
		const Manifest = z.object({ dependencies: z.record(z.string(), z.string()), devDependencies: z.record(z.string(), z.string()) })
		const shown = Manifest.parse(JSON.parse(base.get('package.json') ?? '{}'))
		const template = Manifest.parse(JSON.parse(readFileSync(join(templateDir, 'package.json'), 'utf-8')))
		expect(shown.dependencies).toEqual(template.dependencies)
		expect(shown.devDependencies).toEqual(template.devDependencies)
	})

	for (const app of apps.filter((app) => app.catalog === null)) {
		test(`${app.name}: an application without tables shows no migration`, () => {
			expect(migrationsOf(app).map((block) => block.path)).toEqual([])
		})
	}

	for (const [app, expected] of apps.flatMap((app) => (app.catalog === null ? [] : [[app, app.catalog] as const]))) {
		test(`${app.name}: the migrations are named as the checker requires and the runner refuses none of them`, () => {
			const migrations = migrationsOf(app)
			expect(migrations.length).toBeGreaterThan(0)
			expect(migrations.map((block) => block.path).filter((path) => !/^db\/migrations\/\d{14}_[a-z0-9_]+\.sql$/.test(path ?? ''))).toEqual([])
			const classified = classifyMigrations(migrations.map((block) => ({ name: block.path ?? '', sql: block.code })), app.schema)
			expect(classified.files.flatMap((file) => file.refused.map((refusal) => `${refusal.file}:${refusal.line} ${refusal.reason}`))).toEqual([])
		})

		test(`${app.name}: the migrations migrate to the catalog the generated schema is rendered from`, async () => {
			const migrations = migrationsOf(app)
			const directory = mkdtempSync(join(tmpdir(), 'fabrika-skill-migrations-'))
			for (const block of migrations) writeFileSync(join(directory, basename(block.path ?? '')), block.code)
			const postgres = await testDatabase({ migrations: pathToFileURL(`${directory}/`), label: 'skill-code.test.ts' })
			if (postgres === null) {
				rmSync(directory, { recursive: true })
				return
			}
			try {
				// The runner's manifest: the framework's own bundle first, as `fabrika db migrate` applies it.
				const framework = FRAMEWORK_MIGRATIONS.map((migration) => ({ ...migration, framework: true }))
				const own = migrations.map((block) => ({ name: block.path ?? '', sql: block.code }))
				const classified = classifyMigrations([...framework, ...own], postgres.schema)
				const catalog = await introspectCatalog(process.env['FABRIKA_TEST_POSTGRES_URL'] ?? '', postgres.schema, classified.objects)
				expect(catalog).toEqual(expected)
			} finally {
				await postgres.close()
				rmSync(directory, { recursive: true })
			}
		}, 60_000)
	}
})
