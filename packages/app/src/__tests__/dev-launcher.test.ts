// The launcher of a dev environment against a stub of Control's source receiver: a handler change serves within a
// second, a lockfile change or a change of the contract digest is refused with its reason, a boot reconciles before it serves, and (with
// FABRIKA_TEST_POSTGRES_URL) a migration change migrates and respawns, a reset starts the schema from scratch, and a new
// container over the schema another commit left runs a pending reset first, or reports the failure with its remedy.

import { contractDigest, DEV_LAUNCHER_BOOTED_FILE, DEV_LAUNCHER_STATE_FILE, type DevLauncherConfig } from '@fabrika/auth-core'
import { dropApplicationDatabase } from '@fabrika/platform-node'
import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CONTRACT_FILE, IMPLEMENTATION_FILE } from '../build.js'
import { compileContract } from '../contract/compile.js'
import { type DevLauncher, startDevLauncher } from '../dev/launcher.js'
import { type OutputSink } from '../dev/output.js'
import {
	DEV_SOURCE_REPORT_PATH,
	DEV_SOURCE_WAIT_PATH,
	type DevReport,
	type DevSourceFile,
	type DevWaitAnswer,
	parseDevReport,
	parseDevWaitRequest,
} from '../dev/wire.js'
import { isContractImplementation } from '../implement/implement.js'

setDefaultTimeout(60_000)

const KEY = 'px_test-source-key-0123456789'
const CLI = join(import.meta.dir, '..', '..', '..', 'cli', 'src', 'index.ts')
const POSTGRES_URL = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''

const sha = (seed: number): string => seed.toString(16).padStart(40, '0')
const NOTES_MIGRATION = 'db/migrations/20260101000000_notes.sql'
const NOTES = 'CREATE TABLE notes (id integer PRIMARY KEY);\n'
const TITLE_MIGRATION = 'db/migrations/20260102000000_title.sql'
const TITLE = 'ALTER TABLE notes ADD COLUMN title text;\n'
const SCHEMA_FILE = 'src/db/schema.generated.ts'

/** Control's receiver as the launcher sees it: a linear history of commits, generations, and the reports it got. */
class StubControl {
	readonly reports: DevReport[] = []
	private readonly history: { sha: string; files: readonly DevSourceFile[] }[]
	private waiters: (() => void)[] = []
	private reportWaiters: (() => void)[] = []
	reset = 0
	/** The reset generation the last report said its container applied: what a new container is answered first. */
	resetApplied: number | null = null
	checks = 0
	/** The commit of the current bootstrap run: Control refuses a container of any other. */
	bootstrap: string
	readonly server: ReturnType<typeof Bun.serve>

	constructor(head: string) {
		this.history = [{ sha: head, files: [] }]
		this.bootstrap = head
		this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => this.handle(request) })
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`
	}

	get target(): string {
		return this.history.at(-1)?.sha ?? ''
	}

	commit(commitSha: string, files: Record<string, string | null>): void {
		this.history.push({ sha: commitSha, files: Object.entries(files).map(([path, content]) => ({ path, content })) })
		this.wake()
	}

	supersede(bootstrap: string): void {
		this.bootstrap = bootstrap
		this.wake()
	}

	advance(generation: 'reset' | 'checks'): void {
		this[generation] += 1
		this.wake()
	}

	/** The first report, from now on, that `matches`. */
	nextReport(matches: (report: DevReport) => boolean): Promise<DevReport> {
		const seen = this.reports.length
		return new Promise((resolve) => {
			const check = (): void => {
				const found = this.reports.slice(seen).find(matches)
				if (found === undefined) {
					this.reportWaiters.push(check)
					return
				}
				resolve(found)
			}
			check()
		})
	}

	stop(): void {
		this.server.stop(true)
	}

	private wake(): void {
		const waiters = this.waiters
		this.waiters = []
		for (const waiter of waiters) waiter()
	}

	private async handle(request: Request): Promise<Response> {
		if (request.headers.get('authorization') !== `Bearer ${KEY}`) return new Response('no', { status: 401 })
		const path = new URL(request.url).pathname
		if (path === DEV_SOURCE_REPORT_PATH) {
			const parsed = parseDevReport(await request.json())
			if (!parsed.ok) return new Response('bad report', { status: 400 })
			if (parsed.value.bootstrap !== this.bootstrap) return new Response('superseded', { status: 409 })
			this.reports.push(parsed.value)
			this.resetApplied = parsed.value.reset
			const waiters = this.reportWaiters
			this.reportWaiters = []
			for (const waiter of waiters) waiter()
			return new Response(null, { status: 204 })
		}
		if (path !== DEV_SOURCE_WAIT_PATH) return new Response('not found', { status: 404 })
		const parsed = parseDevWaitRequest(await request.json())
		if (!parsed.ok) return new Response('bad wait', { status: 400 })
		const wait = parsed.value
		const pending = (): boolean =>
			wait.bootstrap !== this.bootstrap || wait.head !== this.target || (wait.reset !== null && wait.reset < this.reset)
			|| (wait.checks !== null && wait.checks < this.checks)
		if (wait.hold && !pending()) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 2_000)
				this.waiters.push(() => {
					clearTimeout(timer)
					resolve()
				})
			})
		}
		if (wait.bootstrap !== this.bootstrap) return new Response('superseded', { status: 409 })
		return Response.json(this.answer(wait.head, wait.reset === null ? Math.min(this.resetApplied ?? 0, this.reset) : this.reset))
	}

	private answer(head: string, reset: number): DevWaitAnswer {
		const index = this.history.findIndex((commit) => commit.sha === head)
		if (head === this.target || index === -1) return { sync: null, reset, checks: this.checks }
		const files = new Map<string, string | null>()
		for (const commit of this.history.slice(index + 1)) {
			for (const file of commit.files) files.set(file.path, file.content)
		}
		return {
			sync: { from: head, to: this.target, files: [...files].map(([path, content]) => ({ path, content })) },
			reset,
			checks: this.checks,
		}
	}
}

const SERVER = `
const port = Number(process.env.PORT)
const { message } = await import('./message.ts')
const runtime = process.env.FABRIKA_APP_RUNTIME_DATABASE_URL
const sql = runtime === undefined ? null : new Bun.SQL(runtime)
Bun.serve({
	port,
	hostname: '127.0.0.1',
	async fetch(request) {
		const url = new URL(request.url)
		if (url.pathname === '/healthz') return new Response('ok')
		if (url.pathname === '/env') {
			return Response.json({
				provisioning: process.env.FABRIKA_APP_DATABASE_URL !== undefined,
				sourceKey: process.env.FABRIKA_PLATFORM_SOURCE_KEY !== undefined,
				runtime: runtime !== undefined,
			})
		}
		if (url.pathname === '/columns') {
			const rows = await sql\`SELECT column_name FROM information_schema.columns WHERE table_schema = \${process.env.SCHEMA} AND table_name = 'notes' ORDER BY column_name\`
			return Response.json(rows.map((row) => row.column_name))
		}
		if (url.pathname === '/insert') {
			await sql.unsafe('INSERT INTO ' + process.env.SCHEMA + '.notes (id) VALUES (1)')
			return new Response('inserted')
		}
		if (url.pathname === '/count') {
			const rows = await sql.unsafe('SELECT count(*)::int AS count FROM ' + process.env.SCHEMA + '.notes')
			return Response.json(rows[0].count)
		}
		return new Response(message)
	},
})
`

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
	const port = probe.port ?? 0
	await probe.stop(true)
	return port
}

interface Fixture {
	readonly root: string
	readonly port: number
	readonly control: StubControl
	readonly lines: string[]
	launcher: DevLauncher | null
}

const fixtures: Fixture[] = []

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.launcher?.stop()
		fixture.control.stop()
		await rm(fixture.root, { recursive: true, force: true })
	}
})

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true })
		await writeFile(join(root, path), content)
	}
}

const EXAMPLE_APP = join(import.meta.dir, '..', '..', '..', '..', 'examples', 'app')

/** The digest the example application's boot computes, as the deploy writes it to `FABRIKA_CONTRACT_DIGEST`. */
async function exampleDigest(root: string): Promise<string> {
	const module: unknown = await import(join(root, IMPLEMENTATION_FILE))
	const app = typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
	if (!isContractImplementation(app)) throw new Error('the example application does not default-export serve(…)')
	return contractDigest(compileContract(app.contract, app.database?.tables ?? {}))
}

async function fixture(options: { controlHead?: string; contractApp?: boolean } = {}): Promise<Fixture> {
	// The example application's sources need its `node_modules`, so that fixture lives inside it.
	const root = options.contractApp === true
		? mkdtempSync(join(EXAMPLE_APP, '.dev-launcher-'))
		: mkdtempSync(join(tmpdir(), 'fabrika-dev-launcher-'))
	if (options.contractApp === true) {
		await cp(join(EXAMPLE_APP, 'src'), join(root, 'src'), { recursive: true })
		await cp(join(EXAMPLE_APP, CONTRACT_FILE), join(root, CONTRACT_FILE))
	}
	await writeTree(root, {
		'package.json': '{ "name": "dev-fixture" }',
		'bun.lock': 'lockfile one',
		'src/server.ts': SERVER,
		'src/message.ts': "export const message = 'one'\n",
		[NOTES_MIGRATION]: NOTES,
	})
	const control = new StubControl(options.controlHead ?? sha(1))
	const value: Fixture = { root, port: await freePort(), control, lines: [], launcher: null }
	fixtures.push(value)
	return value
}

function start(
	value: Fixture,
	database?: { appId: string; url: string },
	deployedDigest?: string,
	spaBuild: string[] = [],
	checks: DevLauncherConfig['checks'] = [{ name: 'tests', command: 'echo checked && exit 3' }],
): DevLauncher {
	const config: DevLauncherConfig = {
		format: 1,
		appId: database?.appId ?? 'devfixture',
		head: sha(1),
		port: value.port,
		healthPath: '/healthz',
		serve: ['bun', 'src/server.ts'],
		migrate: ['bun', CLI, 'db', 'migrate'],
		spaBuild,
		checks,
	}
	const output: OutputSink = { write: (_stream, line) => value.lines.push(line) }
	const environment: Record<string, string> = {
		PATH: process.env['PATH'] ?? '',
		HOME: process.env['HOME'] ?? '',
		PORT: String(value.port),
		FABRIKA_PLATFORM_SOURCE_URL: value.control.url,
		FABRIKA_PLATFORM_SOURCE_KEY: KEY,
		...(deployedDigest === undefined ? {} : { FABRIKA_CONTRACT_DIGEST: deployedDigest }),
		...(database === undefined
			? {}
			: { FABRIKA_APP_DATABASE_URL: database.url, SCHEMA: `app_${database.appId.replaceAll('-', '_')}` }),
	}
	value.launcher = startDevLauncher({ root: value.root, config, environment, source: { url: value.control.url, key: KEY }, output })
	return value.launcher
}

async function get(value: Fixture, path = '/'): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${value.port}${path}`)
	return response.text()
}

async function until(read: () => Promise<string>, expected: string, timeoutMs = 10_000): Promise<number> {
	const started = performance.now()
	while (performance.now() - started < timeoutMs) {
		const text = await read().catch(() => '')
		if (text === expected) return performance.now() - started
		await Bun.sleep(5)
	}
	throw new Error(`never read ${expected}`)
}

describe('the dev launcher', () => {
	test('a handler change serves within a second, and the application holds neither credential', async () => {
		const value = await fixture()
		await start(value).ready
		expect(await get(value)).toBe('one')
		expect(JSON.parse(await get(value, '/env'))).toEqual({ provisioning: false, sourceKey: false, runtime: false })

		const serving = value.control.nextReport((report) => report.status === 'serving' && report.head === sha(2))
		value.control.commit(sha(2), { 'src/message.ts': "export const message = 'two'\n" })
		const elapsed = await until(() => get(value), 'two')
		expect(elapsed).toBeLessThan(1_000)
		expect((await serving).message).toBeNull()
		expect(JSON.parse(readFileSync(join(value.root, DEV_LAUNCHER_STATE_FILE), 'utf8')).head).toBe(sha(2))
	})

	test('a lockfile change is refused with its reason, and the running version keeps serving', async () => {
		const value = await fixture()
		await start(value).ready
		const refused = value.control.nextReport((report) => report.status === 'needs_bootstrap')
		value.control.commit(sha(2), { 'bun.lock': 'lockfile two', 'src/message.ts': "export const message = 'two'\n" })
		const report = await refused
		expect(report.target).toBe(sha(2))
		expect(report.head).toBe(sha(1))
		expect(report.message).toContain('bun.lock changed')
		expect(report.message).toContain('bind_dev')
		expect(readFileSync(join(value.root, 'bun.lock'), 'utf8')).toBe('lockfile one')
		expect(await get(value)).toBe('one')
	})

	test('a container that a newer bootstrap run replaced stops following Control and applies nothing', async () => {
		const value = await fixture()
		await start(value).ready
		const reported = value.control.reports.length
		value.control.supersede(sha(9))
		value.control.commit(sha(2), { 'bun.lock': 'lockfile two', 'src/message.ts': "export const message = 'two'\n" })
		const deadline = performance.now() + 5_000
		while (!value.lines.some((line) => line.includes('a newer bootstrap run replaced this container'))) {
			if (performance.now() > deadline) throw new Error('the launcher never stopped following Control')
			await Bun.sleep(5)
		}
		expect(value.control.reports.length).toBe(reported)
		expect(readFileSync(join(value.root, 'bun.lock'), 'utf8')).toBe('lockfile one')
		expect(await get(value)).toBe('one')
	})

	test('an edit of a handler syncs, and an edit that changes the contract digest is refused and rolled back with its SPA', async () => {
		const value = await fixture({ contractApp: true })
		await writeTree(value.root, { 'web/title.txt': 'one' })
		const built = () => readFileSync(join(value.root, 'dist', 'title.txt'), 'utf8')
		await start(value, undefined, await exampleDigest(value.root), ['mkdir -p dist && cp web/title.txt dist/title.txt']).ready
		const endpoints = 'src/access/endpoints.ts'
		const original = readFileSync(join(value.root, endpoints), 'utf8')
		const reworded = original.replace('label: ctx.principal.label', 'label: `${ctx.principal.label}!`')
		expect(reworded).not.toBe(original)

		const serving = value.control.nextReport((report) => report.status === 'serving' && report.head === sha(2))
		value.control.commit(sha(2), { [endpoints]: reworded, 'src/message.ts': "export const message = 'two'\n", 'web/title.txt': 'two' })
		expect((await serving).message).toBeNull()
		expect(await get(value)).toBe('two')
		expect(built()).toBe('two')

		const widened = reworded.replace('access: { member: true }', "access: { action: 'example.read', over: 'project' }")
		const refused = value.control.nextReport((report) => report.status === 'needs_bootstrap')
		value.control.commit(sha(3), { [endpoints]: widened, 'web/title.txt': 'three' })
		const report = await refused
		expect(report.message).toContain('the change alters the contract')
		expect(report.message).toContain('bind_dev')
		expect(report.head).toBe(sha(2))
		expect(readFileSync(join(value.root, endpoints), 'utf8')).toBe(reworded)
		expect(await get(value)).toBe('two')
		expect(built()).toBe('two')
	})

	test('a boot reconciles to the recorded head before it serves', async () => {
		const value = await fixture()
		value.control.commit(sha(2), { 'src/message.ts': "export const message = 'two'\n", 'src/old.ts': null })
		await start(value).ready
		expect(await get(value)).toBe('two')
		const served = value.control.reports.filter((report) => report.status === 'serving')
		expect(served.map((report) => report.head)).toEqual([sha(2)])
		expect(existsSync(join(value.root, DEV_LAUNCHER_STATE_FILE))).toBe(true)
	})

	test('a restart of the same container resumes from its recorded head', async () => {
		const value = await fixture()
		await start(value).ready
		value.control.commit(sha(2), { 'src/message.ts': "export const message = 'two'\n" })
		await until(() => get(value), 'two')
		await value.launcher?.stop()
		value.control.commit(sha(3), { 'src/message.ts': "export const message = 'three'\n" })
		await start(value).ready
		expect(await get(value)).toBe('three')
	})

	test('a check request runs the chain and reports its results without stopping the application', async () => {
		const value = await fixture()
		await start(value).ready
		const checked = value.control.nextReport((report) => report.checks !== null)
		value.control.advance('checks')
		const report = await checked
		expect(report.checks?.request).toBe(1)
		expect(report.checks?.results).toEqual([{ name: 'tests', ok: false, exitCode: 3, durationMs: expect.any(Number), output: ['checked'] }])
		expect(report.status).toBe('serving')
		expect(await get(value)).toBe('one')
	})

	test('a check killed by a signal fails with a line that says so, and the next check still runs', async () => {
		const value = await fixture()
		await start(value, undefined, undefined, [], [{ name: 'tsc', command: 'kill -9 $$' }, { name: 'tests', command: 'echo checked' }]).ready
		const checked = value.control.nextReport((report) => report.checks !== null)
		value.control.advance('checks')
		const [killed, passed] = (await checked).checks?.results ?? []
		expect({ ok: killed?.ok, exitCode: killed?.exitCode }).toEqual({ ok: false, exitCode: null })
		expect(killed?.output.at(-1)).toBe(
			'check tsc was killed (SIGKILL) before it finished, most likely because the container ran out of memory; it failed',
		)
		expect({ ok: passed?.ok, exitCode: passed?.exitCode }).toEqual({ ok: true, exitCode: 0 })
	})

	test('a report carries the lines of the newest sync and the output after it, not the lines before', async () => {
		const value = await fixture()
		await start(value).ready
		const first = value.control.nextReport((report) => report.status === 'serving' && report.head === sha(2))
		value.control.commit(sha(2), { 'src/message.ts': "export const message = 'two'\n" })
		const firstLog = (await first).log
		expect(firstLog.some((line) => line.text.includes(`synced 1 files to ${sha(2)}`))).toBe(true)

		const second = value.control.nextReport((report) => report.status === 'serving' && report.head === sha(3))
		value.control.commit(sha(3), { 'src/message.ts': "export const message = 'three'\n" })
		const secondLog = (await second).log
		expect(secondLog.some((line) => line.text.includes(`synced 1 files to ${sha(3)}`))).toBe(true)
		expect(secondLog.some((line) => line.text.includes(sha(2)))).toBe(false)
		expect(secondLog.every((line) => line.n > (firstLog.at(-1)?.n ?? -1))).toBe(true)
	})

	test("bun's echo of the SPA script it runs is reported on stdout, not as an error", async () => {
		const value = await fixture()
		await writeTree(value.root, { 'web/title.txt': 'one' })
		await start(value, undefined, undefined, ["echo '$ bun build-web.ts' >&2 && echo built"]).ready
		const serving = value.control.nextReport((report) => report.status === 'serving' && report.head === sha(2))
		value.control.commit(sha(2), { 'web/title.txt': 'two' })
		const log = (await serving).log
		expect(log.find((line) => line.text === '$ bun build-web.ts')?.stream).toBe('stdout')
		expect(log.find((line) => line.text === 'built')?.stream).toBe('stdout')
	})
})

/** Run the CLI in `root` against the test database as `appId`; a failure throws with its last line. */
async function cli(root: string, appId: string, args: readonly string[]): Promise<void> {
	const child = Bun.spawn(['bun', CLI, ...args], {
		cwd: root,
		env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', FABRIKA_APP_ID: appId, FABRIKA_APP_DATABASE_URL: POSTGRES_URL },
		stdout: 'ignore',
		stderr: 'pipe',
	})
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
	if (code !== 0) throw new Error(`fabrika ${args.join(' ')} failed: ${stderr.trim().split('\n').at(-1)}`)
}

/** The schema types `fabrika db codegen` writes for `migrations`, generated on a scratch schema: what a commit holds. */
async function committedSchema(migrations: Record<string, string>): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-dev-schema-'))
	const scratch = `devschema-${crypto.randomUUID().slice(0, 8)}`
	try {
		await writeTree(root, migrations)
		await cli(root, scratch, ['db', 'migrate'])
		await cli(root, scratch, ['db', 'codegen'])
		return readFileSync(join(root, SCHEMA_FILE), 'utf8')
	} finally {
		await dropApplicationDatabase(POSTGRES_URL, scratch)
		await rm(root, { recursive: true, force: true })
	}
}

async function tableNames(appId: string): Promise<string[]> {
	const sql = new Bun.SQL(POSTGRES_URL)
	try {
		const rows: unknown = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${`app_${appId.replaceAll('-', '_')}`}`
		return Array.isArray(rows) ? rows.map((row) => String(Reflect.get(row, 'table_name'))).sort() : []
	} finally {
		await sql.close()
	}
}

const booted = (report: DevReport): boolean => report.status === 'serving' || report.status === 'failed'

describe.skipIf(POSTGRES_URL === '')('the dev launcher with a database', () => {
	const appId = `devlaunch-${crypto.randomUUID().slice(0, 8)}`
	let notesSchema = ''
	let titleSchema = ''

	beforeAll(async () => {
		notesSchema = await committedSchema({ [NOTES_MIGRATION]: NOTES })
		titleSchema = await committedSchema({ [NOTES_MIGRATION]: NOTES, [TITLE_MIGRATION]: TITLE })
	})

	afterEach(async () => {
		await dropApplicationDatabase(POSTGRES_URL, appId)
	})

	/** A fixture that holds the committed schema types of its migrations, as the bootstrap's verification needs. */
	async function databaseFixture(): Promise<Fixture> {
		const value = await fixture()
		await writeTree(value.root, { [SCHEMA_FILE]: notesSchema })
		return value
	}

	test('a migration change migrates and respawns; a reset starts the schema from scratch', async () => {
		const value = await databaseFixture()
		const database = { appId, url: POSTGRES_URL }
		await start(value, database).ready
		expect(JSON.parse(await get(value, '/env'))).toEqual({ provisioning: false, sourceKey: false, runtime: true })
		expect(await get(value, '/columns')).toBe('["id"]')

		value.control.commit(sha(2), { [TITLE_MIGRATION]: TITLE, [SCHEMA_FILE]: titleSchema })
		await until(() => get(value, '/columns'), '["id","title"]')

		expect(await get(value, '/insert')).toBe('inserted')
		expect(await get(value, '/count')).toBe('1')
		const reset = value.control.nextReport((report) => report.reset === 1 && report.status === 'serving')
		value.control.advance('reset')
		await reset
		expect(await get(value, '/count')).toBe('0')
		expect(await get(value, '/columns')).toBe('["id","title"]')
	})

	test('a changed applied migration fails the sync with one line that names reset_dev', async () => {
		const value = await databaseFixture()
		await start(value, { appId, url: POSTGRES_URL }).ready
		const failed = value.control.nextReport((report) => report.status === 'failed')
		value.control.commit(sha(2), { [NOTES_MIGRATION]: 'CREATE TABLE notes (id bigint PRIMARY KEY);\n' })
		const report = await failed
		expect(report.head).toBe(sha(2))
		expect(report.message).toContain('fabrika db migrate failed')
		expect(report.message).toContain('reset_dev')
	})

	test("a new container over another commit's schema runs the pending reset before it migrates and verifies", async () => {
		const value = await databaseFixture()
		const workspaceA = 'db/migrations/20260103000000_workspace_a.sql'
		await writeTree(value.root, { [workspaceA]: 'CREATE TABLE workspace_a (id integer PRIMARY KEY);\n' })
		await cli(value.root, appId, ['db', 'migrate'])
		await rm(join(value.root, workspaceA))
		value.control.resetApplied = 0
		value.control.reset = 1

		const report = value.control.nextReport(booted)
		await start(value, { appId, url: POSTGRES_URL }).ready
		expect(await report).toMatchObject({ status: 'serving', reset: 1, message: null })
		expect(await tableNames(appId)).not.toContain('workspace_a')
		expect(existsSync(join(value.root, DEV_LAUNCHER_BOOTED_FILE))).toBe(true)
	})

	test("a new container over another commit's schema reports the failed check with reset_dev, which recovers it", async () => {
		const value = await databaseFixture()
		const workspaceA = 'db/migrations/20260103000000_workspace_a.sql'
		await writeTree(value.root, { [workspaceA]: 'CREATE TABLE workspace_a (id integer PRIMARY KEY);\n' })
		await cli(value.root, appId, ['db', 'migrate'])
		await rm(join(value.root, workspaceA))

		const failed = value.control.nextReport(booted)
		await start(value, { appId, url: POSTGRES_URL }).ready
		const report = await failed
		expect(report.status).toBe('failed')
		expect(report.message).toContain('fabrika db codegen --verify failed')
		expect(report.message).toContain('reset_dev')
		expect(existsSync(join(value.root, DEV_LAUNCHER_BOOTED_FILE))).toBe(true)

		const recovered = value.control.nextReport((next) => next.reset === 1 && booted(next))
		value.control.advance('reset')
		expect(await recovered).toMatchObject({ status: 'serving', message: null })
		expect(await tableNames(appId)).not.toContain('workspace_a')
	})

	test('a new container whose applied migration its commit edited reports the failure with reset_dev, which recovers it', async () => {
		const value = await databaseFixture()
		await cli(value.root, appId, ['db', 'migrate'])
		const bigint = 'CREATE TABLE notes (id bigint PRIMARY KEY);\n'
		await writeTree(value.root, { [NOTES_MIGRATION]: bigint, [SCHEMA_FILE]: await committedSchema({ [NOTES_MIGRATION]: bigint }) })

		const failed = value.control.nextReport(booted)
		await start(value, { appId, url: POSTGRES_URL }).ready
		const report = await failed
		expect(report.status).toBe('failed')
		expect(report.message).toContain('fabrika db migrate failed')
		expect(report.message).toContain('reset_dev')

		const recovered = value.control.nextReport((next) => next.reset === 1 && booted(next))
		value.control.advance('reset')
		expect(await recovered).toMatchObject({ status: 'serving', message: null })
	})
})
