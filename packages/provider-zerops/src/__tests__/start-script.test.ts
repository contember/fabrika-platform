// The generated init commands and start script of a contract application, run in Zerops' order against a REAL Postgres
// with the real `fabrika` CLI: a committed `schema.generated.ts` that no longer matches the migrated schema fails an
// init command, which stops the activation before the server starts. Skips cleanly without FABRIKA_TEST_POSTGRES_URL;
// the URL is a credential and is never printed.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dropApplicationDatabase } from '../../../platform-node/src/application-postgres-migrations'
import { FABRIKA_CHECK_VERSION, generatedBuildCommands, generatedInitCommands, type ZeropsLockedExecution } from '../execution'

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) console.warn('start-script.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to run the generated start script against Postgres')

const CLI = join(import.meta.dir, '..', '..', '..', 'cli', 'src', 'index.ts')
const STARTED = 'the server started'
const roots: string[] = []
const appIds: string[] = []

afterAll(async () => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
	if (!hasPostgres) return
	for (const appId of appIds) await dropApplicationDatabase(url, appId)
})

const sh = async (root: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
	const child = Bun.spawn(['sh', ...args], {
		cwd: root,
		env: { ...process.env, FABRIKA_APP_DATABASE_URL: url },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { code, stdout, stderr }
}

const SCRIPTS = ['fabrika/migrate.generated.sh', 'fabrika/verify.generated.sh', 'fabrika/start.generated.sh']

/** Runs every init command, then the start script, stopping at the first failure as Zerops stops the activation. */
const activate = async (root: string, execution: ZeropsLockedExecution): Promise<{ code: number; stdout: string; stderr: string }> => {
	const output = { stdout: '', stderr: '' }
	for (const command of [...generatedInitCommands(execution), 'sh /var/www/fabrika/start.generated.sh']) {
		const step = await sh(root, ['-c', command.replaceAll('/var/www', root)])
		output.stdout += step.stdout
		output.stderr += step.stderr
		if (step.code !== 0) return { code: step.code, ...output }
	}
	return { code: 0, ...output }
}

const executionOf = (appId: string): ZeropsLockedExecution => ({
	appId,
	contract: { digest: `sha256:${'0'.repeat(64)}`, readinessPath: '/healthz', jobs: [] },
	databaseUrl: '${notesdb_connectionTlsString}/${notesdb_dbName}?sslmode=require',
	databaseConnections: 2,
	checkRelease: FABRIKA_CHECK_VERSION,
	storageHostname: null,
	runtimePackages: [],
	sourceMaps: null,
})

/**
 * Writes the generated scripts into an application root, as the platform build does, then points them at that root,
 * the workspace CLI and a stand-in for the server instead of `/var/www`, `node_modules/.bin` and the entrypoint.
 */
const generatedApplication = async (execution: ZeropsLockedExecution): Promise<string> => {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-start-script-'))
	roots.push(root)
	mkdirSync(join(root, 'fabrika'))
	for (const command of generatedBuildCommands(execution).filter((line) => line.includes('.generated.sh'))) {
		expect((await sh(root, ['-c', command])).code).toBe(0)
	}
	for (const script of SCRIPTS) {
		const text = readFileSync(join(root, script), 'utf8')
			.replaceAll('/var/www', root)
			.replaceAll('./node_modules/.bin/fabrika', `bun ${CLI}`)
			.replace('exec bun --max-http-header-size=65536 fabrika/entry.generated.ts', `echo '${STARTED}'`)
		writeFileSync(join(root, script), text)
	}
	mkdirSync(join(root, 'db', 'migrations'), { recursive: true })
	writeFileSync(join(root, 'db', 'migrations', '20261008120000_init.sql'), 'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
	return root
}

describe.skipIf(!hasPostgres)('the generated init commands and start script against Postgres', () => {
	test('a stale committed schema module stops the activation, and a current one starts the server', async () => {
		const appId = `stale-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
		appIds.push(appId)
		const execution = executionOf(appId)
		const root = await generatedApplication(execution)
		mkdirSync(join(root, 'src', 'db'), { recursive: true })
		writeFileSync(join(root, 'src', 'db', 'schema.generated.ts'), 'export interface DB {}\n')

		const stale = await activate(root, execution)
		expect(stale.code).not.toBe(0)
		expect(stale.stderr).toContain('src/db/schema.generated.ts is stale')
		expect(stale.stdout).not.toContain(STARTED)

		const codegen = Bun.spawn(['bun', CLI, 'db', 'codegen'], {
			cwd: root,
			env: { ...process.env, FABRIKA_APP_ID: appId, FABRIKA_APP_DATABASE_URL: url },
			stdout: 'ignore',
			stderr: 'ignore',
		})
		expect(await codegen.exited).toBe(0)
		const current = await activate(root, execution)
		expect(current.code).toBe(0)
		expect(current.stdout).toContain(STARTED)
	})

	test('a migration that fails stops the activation before the schema is verified', async () => {
		const appId = `broken-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
		appIds.push(appId)
		const execution = executionOf(appId)
		const root = await generatedApplication(execution)
		writeFileSync(join(root, 'db', 'migrations', '20261009120000_broken.sql'), 'ALTER TABLE missing_table ADD COLUMN body TEXT')

		const started = await activate(root, execution)
		expect(started.code).not.toBe(0)
		expect(started.stderr).toContain('relation "missing_table" does not exist')
		expect(started.stderr).not.toContain('schema.generated.ts')
		expect(started.stdout).not.toContain(STARTED)
	})
})
