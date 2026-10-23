// `fabrika db` for an application on Cloudflare, whose `fabrika.config.ts` is `@fabrika/provider-cloudflare`'s: its
// data layer is SQLite in its Durable Object (ADR-0065), so no command needs a database URL.

import { checkApplication, formatFinding } from '@fabrika/check'
import { generateSqliteSchema } from '@fabrika/db/codegen-sqlite'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDbCommand } from '../db'

// The scaffold cases run the whole checker over a copied fixture, and test-isolation runs every generated case.
setDefaultTimeout(30_000)

const CLOUDFLARE_CONFIG =
	"import { defineApp } from '@fabrika/provider-cloudflare'\n\nexport default defineApp({ id: 'notes', resources: () => [] })\n"
const ZEROPS_CONFIG =
	"import { defineApp } from '@fabrika/provider-zerops'\n\nexport default defineApp({ id: 'notes', target: { platform: 'zerops' } })\n"
const SCHEMA = 'src/db/schema.generated.ts'

const roots: string[] = []
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const appRoot = (config: string): string => {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-db-cloudflare-'))
	roots.push(root)
	writeFileSync(join(root, 'fabrika.config.ts'), config)
	return root
}

const run = async (root: string, command: string, argv: readonly string[] = [], source: Record<string, string | undefined> = {}): Promise<string> => {
	const output: string[] = []
	await runDbCommand(command, argv, { cwd: root, source, now: () => new Date('2026-10-22T12:00:00.000Z'), write: (line) => output.push(line) })
	return output.join('')
}

const failure = async (work: Promise<unknown>): Promise<string> => {
	try {
		await work
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('the command did not fail')
}

const writeMigration = (root: string, name: string, sql: string): void => {
	mkdirSync(join(root, 'db', 'migrations'), { recursive: true })
	writeFileSync(join(root, 'db', 'migrations', name), sql)
}

const NOTES = 'create table notes (id text primary key, title text not null, pinned integer not null) strict;\n'

describe('fabrika db on Cloudflare', () => {
	test('codegen writes the schema module of the SQLite migrations with no database URL, and --verify fails once it is stale', async () => {
		const root = appRoot(CLOUDFLARE_CONFIG)
		writeMigration(root, '20261022120000_notes.sql', NOTES)
		expect(await run(root, 'codegen')).toBe(`${SCHEMA}\n`)
		const written = readFileSync(join(root, SCHEMA), 'utf8')
		expect(written).toBe(
			await generateSqliteSchema([
				{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS },
				{ bundle: 'app', migrations: [{ name: '20261022120000_notes.sql', sql: NOTES }] },
			]),
		)
		expect(written).toContain('export interface NotesTable {\n\tid: string\n\ttitle: string\n\tpinned: number\n}')
		expect(written).not.toContain('fabrika_')
		expect(await run(root, 'codegen', ['--verify'])).toBe(`${SCHEMA} is current\n`)
		writeMigration(root, '20261022120100_tags.sql', 'create table tags (id text primary key) strict;\n')
		expect(await failure(run(root, 'codegen', ['--verify']))).toBe(`${SCHEMA} is stale; run fabrika db codegen and commit the result`)
	})

	test('migrate refuses: the Durable Object migrates its own database when it boots', async () => {
		const root = appRoot(CLOUDFLARE_CONFIG)
		writeMigration(root, '20261022120000_notes.sql', NOTES)
		expect(await failure(run(root, 'migrate'))).toBe(
			'db migrate: an application on Cloudflare migrates its own SQLite database when its Durable Object boots (ADR-0065); there is nothing to run',
		)
	})

	test('a Zerops application still needs the Postgres environment for migrate and codegen', async () => {
		const root = appRoot(ZEROPS_CONFIG)
		expect(await failure(run(root, 'migrate'))).toBe('FABRIKA_APP_ID is required')
		expect(await failure(run(root, 'codegen'))).toBe('FABRIKA_APP_ID is required')
	})
})

/** The fixture application whose generated tests are committed for Postgres; its migrations are also valid SQLite. */
const ISOLATION_APP = join(import.meta.dir, 'fixtures', 'isolation-app')
const GENERATED = [
	...['note_comments', 'notes', 'notices', 'organizations', 'workspace_events', 'workspaces'].map((table) =>
		`src/db/__tests__/${table}.policy-isolation.test.ts`
	),
	'src/__tests__/endpoint-access.test.ts',
]

const isolationApp = (config: string): string => {
	const root = appRoot(config)
	cpSync(ISOLATION_APP, root, { recursive: true })
	return root
}

describe('the generated tests on Cloudflare', () => {
	test('test-scaffold writes them on the SQLite kit, and the checker accepts them', async () => {
		const root = isolationApp(CLOUDFLARE_CONFIG)
		expect((await run(root, 'test-scaffold')).split('\n').filter((line) => line !== '')).toEqual(GENERATED)
		for (const path of GENERATED) {
			const text = readFileSync(join(root, path), 'utf8')
			expect(text).toContain("import { testDatabase } from '@fabrika/db/testing-sqlite'\n")
			expect(text).not.toContain("from '@fabrika/db/testing'\n")
		}
		expect((await checkApplication({ root })).map(formatFinding).filter((line) => line.includes('generated-test-hash'))).toEqual([])
	})

	test('test-scaffold of a Zerops application writes the committed tests on the Postgres kit', async () => {
		const root = isolationApp(ZEROPS_CONFIG)
		await run(root, 'test-scaffold')
		for (const path of GENERATED) {
			const text = readFileSync(join(root, path), 'utf8')
			expect(text).toBe(readFileSync(join(ISOLATION_APP, path), 'utf8'))
			expect(text).toContain("import { testDatabase } from '@fabrika/db/testing'\n")
		}
	})

	test('test-isolation runs them with no database URL', async () => {
		const root = isolationApp(CLOUDFLARE_CONFIG)
		symlinkSync(join(import.meta.dir, '..', '..', 'node_modules'), join(root, 'node_modules'))
		await run(root, 'test-scaffold')
		expect(await run(root, 'test-isolation', [], { PATH: process.env['PATH'] })).toBe('104 generated cases passed\n')
	})
})
