// The `run` variant of a `dev` environment (ADR-0049, ADR-0043): the same checked build, with `run.start` running the dev
// launcher of the application's own release, no init command (the launcher migrates and verifies after Control's answer),
// a readiness check that also passes once the launcher reported its boot, and no health check that would restart a
// container whose launcher keeps running. The generated files are written by a real shell.

import { DEV_LAUNCHER_BOOTED_FILE, DEV_LAUNCHER_CONFIG_FILE, type DevLauncherConfig } from '@fabrika/auth-core'
import type { JsonValue } from '@fabrika/provider-contract'
import { SQL } from 'bun'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { parseZeropsDescriptor } from '../descriptor'
import {
	devLauncherConfig,
	FABRIKA_CHECK_VERSION,
	generatedBuildCommands,
	generatedInitCommands,
	PLATFORM_TYPESCRIPT_VERSION,
	renderLockedExecutionDescriptor,
	type ZeropsLockedExecution,
} from '../execution'

const HEAD = 'c'.repeat(40)
const POSTGRES_URL = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const ZEROPS_APP = join(import.meta.dir, '..', '..', '..', '..', 'examples', 'zerops-app')
const SPA = ["bun run build:spa --mode 'dev'", 'echo $HOME']
const DESCRIPTOR = `zerops:\n  - setup: notesapi\n    build:\n      buildCommands: ${JSON.stringify(SPA)}\n`

const execution = (dev: boolean): ZeropsLockedExecution => ({
	appId: 'notes',
	contract: { digest: `sha256:${'0'.repeat(64)}`, readinessPath: '/healthz', jobs: [{ name: 'digest', schedule: '0 3 * * *' }] },
	checkRelease: FABRIKA_CHECK_VERSION,
	databaseUrl: '${notesdb_connectionString}',
	databaseConnections: 3,
	storageHostname: null,
	runtimePackages: [],
	sourceMaps: null,
	...(dev ? { dev: { head: HEAD } } : {}),
})

type Mapping = { readonly [key: string]: JsonValue }

const mapping = (value: JsonValue | undefined): Mapping => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a mapping')
	return value
}

const render = (dev: boolean): Mapping => {
	const rendered = renderLockedExecutionDescriptor(DESCRIPTOR, 'notesapi', 'r1', execution(dev))
	const setups = parseZeropsDescriptor(rendered.contents).document['zerops']
	if (!Array.isArray(setups)) throw new Error('expected setups')
	return mapping(setups[0])
}

const roots: string[] = []
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** An application root inside the worked example, so `bun` resolves the workspace's `@fabrika/app` from it. */
const applicationRoot = (): string => {
	const root = mkdtempSync(join(import.meta.dir, '..', '..', '..', '..', 'examples', 'app', '.dev-execution-'))
	roots.push(root)
	mkdirSync(join(root, 'fabrika'))
	return root
}

const sh = async (root: string, command: string, env: Record<string, string> = {}) => {
	const child = Bun.spawn(['sh', '-c', command], { cwd: root, env: { PATH: process.env['PATH'] ?? '', ...env }, stdout: 'pipe', stderr: 'pipe' })
	const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { code, stdout, stderr }
}

describe('the run variant of a dev environment', () => {
	test('builds with every check, starts the launcher, and has neither an init command nor a health check', () => {
		const ordinary = render(false)
		const dev = render(true)
		expect(mapping(ordinary['run'])['initCommands']).toEqual(['sh /var/www/fabrika/migrate.generated.sh', 'sh /var/www/fabrika/verify.generated.sh'])
		const run = mapping(dev['run'])
		expect(run['start']).toBe('sh /var/www/fabrika/start.generated.sh')
		expect(run['initCommands']).toBeUndefined()
		expect(run['healthCheck']).toBeUndefined()
		expect(run['crontab']).toEqual(mapping(ordinary['run'])['crontab'])
		expect(run['envVariables']).toEqual(mapping(ordinary['run'])['envVariables'])
		const commands = mapping(dev['build'])['buildCommands']
		if (!Array.isArray(commands)) throw new Error('expected build commands')
		for (const check of ["'test', '--isolate'", 'fabrika-check', ' tsc ']) {
			expect(commands.some((command) => String(command).includes(check))).toBe(true)
		}
	})

	test('the launcher configuration names the bootstrap head, the authored SPA commands and the check chain', () => {
		const config = devLauncherConfig(execution(true), SPA)
		expect({ ...config, checks: [] }).toEqual(
			{
				format: 1,
				appId: 'notes',
				head: HEAD,
				port: 3000,
				healthPath: '/healthz',
				serve: ['bun', 'fabrika/entry.generated.ts'],
				migrate: ['./node_modules/.bin/fabrika', 'db', 'migrate'],
				spaBuild: SPA,
				checks: [],
			} satisfies DevLauncherConfig,
		)
		expect(() => devLauncherConfig(execution(false), SPA)).toThrow('needs a dev environment')
	})

	test("run_checks runs the build's own check commands, in the build's order, on the runtime root", () => {
		const { checks } = devLauncherConfig(execution(true), SPA)
		expect(checks.map((check) => check.name)).toEqual(['tests', 'tsc', 'fabrika-check'])
		const build = generatedBuildCommands(execution(true), SPA)
		const positions = checks.map((check) => build.indexOf(check.command.replaceAll('/var/www', '/build/source')))
		expect(positions.every((position) => position >= 0)).toBe(true)
		expect([...positions].sort((left, right) => left - right)).toEqual(positions)
		expect(checks.find((check) => check.name === 'tsc')?.command).toBe(
			`cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p /var/www/fabrika/tsconfig.platform.json`,
		)
		expect(checks.find((check) => check.name === 'fabrika-check')?.command).toContain(`@fabrika/check@${FABRIKA_CHECK_VERSION}`)
	})

	test('the build writes the configuration whole, quotes and expansions included, and a start script that runs the launcher', async () => {
		const root = applicationRoot()
		const written = generatedBuildCommands(execution(true), SPA).filter((command) => command.includes(' > fabrika/'))
		for (const command of written) expect((await sh(root, command)).code).toBe(0)
		expect(JSON.parse(readFileSync(join(root, DEV_LAUNCHER_CONFIG_FILE), 'utf8'))).toEqual(devLauncherConfig(execution(true), SPA))
		const start = readFileSync(join(root, 'fabrika/start.generated.sh'), 'utf8').replaceAll('/var/www', root)
		writeFileSync(join(root, 'fabrika/start.generated.sh'), start)
		// The launcher of this release starts and refuses to run without its receiver, which the platform writes.
		const started = await sh(root, 'sh fabrika/start.generated.sh')
		expect(started.code).not.toBe(0)
		expect(started.stderr).toContain('FABRIKA_PLATFORM_SOURCE_URL and FABRIKA_PLATFORM_SOURCE_KEY are not set')
	})

	test('the readiness check passes on the health endpoint, or on a dev container once its launcher reported the boot', async () => {
		const root = applicationRoot()
		const port = await freePort()
		const readiness = (dev: boolean): string => {
			const check = mapping(mapping(mapping(render(dev)['deploy'])['readinessCheck'])['exec'])['command']
			if (typeof check !== 'string') throw new Error('expected a readiness command')
			return check.replaceAll('127.0.0.1:3000', `127.0.0.1:${port}`).replaceAll('/var/www', root)
		}
		writeFileSync(join(root, DEV_LAUNCHER_BOOTED_FILE), '')
		expect((await sh(root, readiness(false))).code).toBe(1)
		expect((await sh(root, readiness(true))).code).toBe(0)
		const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('ok') })
		try {
			expect((await sh(root, readiness(false))).code).toBe(0)
		} finally {
			await server.stop(true)
		}
	}, 20_000)
})

const SOURCE_KEY = 'px_test-source-key-0123456789'
const reportSchema = z.object({ status: z.string(), reset: z.number().nullable(), message: z.string().nullable() })
type Report = z.infer<typeof reportSchema>

/** Control's receiver for one dev environment whose reset generation is ahead of the one the previous container applied. */
function pendingResetControl(applied: number, generation: number) {
	const reports: Report[] = []
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			if (request.headers.get('authorization') !== `Bearer ${SOURCE_KEY}`) return new Response('no', { status: 401 })
			const body: unknown = await request.json()
			if (new URL(request.url).pathname.endsWith('/report')) {
				reports.push(reportSchema.parse(body))
				return new Response(null, { status: 204 })
			}
			const { reset } = z.object({ reset: z.number().nullable() }).parse(body)
			return Response.json({ sync: null, reset: reset === null ? applied : generation, checks: 0 })
		},
	})
	return { reports, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
	const port = probe.port ?? 0
	await probe.stop(true)
	return port
}

const NOTES_MIGRATION = 'db/migrations/20261009140000_notes.sql'

/**
 * A new dev container of `appId` from the generated build, init commands and start script, over the database `seed`
 * left: it runs the init, starts the launcher against a receiver whose reset generation is `pending` ahead of the one
 * the previous container applied, and returns the boot's report and the readiness check's exit code.
 */
async function bootNewContainer(
	appId: string,
	seed: (root: string, database: Record<string, string>) => Promise<void>,
	pending: number,
): Promise<{ readonly report: Report | undefined; readonly readiness: number; readonly root: string }> {
	const root = mkdtempSync(join(ZEROPS_APP, '.dev-boot-'))
	roots.push(root)
	for (const path of ['package.json', 'fabrika.config.ts', 'db', 'src/db/schema.generated.ts']) {
		cpSync(join(ZEROPS_APP, path), join(root, path), { recursive: true })
	}
	symlinkSync(join(ZEROPS_APP, 'node_modules'), join(root, 'node_modules'))
	mkdirSync(join(root, 'fabrika'))
	await seed(root, { FABRIKA_APP_ID: appId, FABRIKA_APP_DATABASE_URL: POSTGRES_URL })

	const dev = { ...execution(true), appId }
	const written = generatedBuildCommands(dev, []).filter((command) => command.includes(' > fabrika/'))
	for (const command of written) expect((await sh(root, command)).code).toBe(0)
	for (const name of readdirSync(join(root, 'fabrika')).filter((file) => file.endsWith('.generated.sh'))) {
		const script = join(root, 'fabrika', name)
		writeFileSync(script, readFileSync(script, 'utf8').replaceAll('/var/www', root))
	}
	for (const command of generatedInitCommands(dev)) {
		expect(await sh(root, command.replaceAll('/var/www', root), { FABRIKA_APP_DATABASE_URL: POSTGRES_URL })).toMatchObject({ code: 0 })
	}

	// The served application is not what this test is about: a stand-in answers the health path on a free port.
	const port = await freePort()
	writeFileSync(join(root, 'serve.ts'), "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') })\n")
	const config: DevLauncherConfig = { ...devLauncherConfig(dev, []), port, serve: ['bun', 'serve.ts'] }
	writeFileSync(join(root, DEV_LAUNCHER_CONFIG_FILE), JSON.stringify(config))
	const check = mapping(mapping(mapping(render(true)['deploy'])['readinessCheck'])['exec'])['command']
	if (typeof check !== 'string') throw new Error('expected a readiness command')
	// No application answers here: the check passes only on the launcher's report of its boot.
	const readiness = check.replaceAll('127.0.0.1:3000', `127.0.0.1:${await freePort()}`).replaceAll('/var/www', root)

	const control = pendingResetControl(0, pending)
	const launcher = Bun.spawn(['sh', 'fabrika/start.generated.sh'], {
		cwd: root,
		env: {
			PATH: process.env['PATH'] ?? '',
			HOME: process.env['HOME'] ?? '',
			PORT: String(port),
			FABRIKA_APP_DATABASE_URL: POSTGRES_URL,
			FABRIKA_PLATFORM_SOURCE_URL: control.url,
			FABRIKA_PLATFORM_SOURCE_KEY: SOURCE_KEY,
		},
		stdout: 'ignore',
		stderr: 'ignore',
	})
	try {
		const booted = (report: Report): boolean => report.status === 'serving' || report.status === 'failed'
		const deadline = performance.now() + 60_000
		while (!control.reports.some(booted)) {
			if (performance.now() > deadline) throw new Error('the launcher never reported its boot')
			await Bun.sleep(50)
		}
		return { report: control.reports.find(booted), readiness: (await sh(root, readiness)).code, root }
	} finally {
		launcher.kill('SIGTERM')
		await launcher.exited
		control.stop()
	}
}

describe.skipIf(POSTGRES_URL === '')('a new dev container over a schema that another commit left', () => {
	const appId = `devboot-${crypto.randomUUID().slice(0, 8)}`
	const schema = `app_${appId.replaceAll('-', '_')}`

	afterEach(async () => {
		const sql = new SQL(POSTGRES_URL)
		await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
		for (const role of [schema, `run_${schema.slice('app_'.length)}`]) {
			const exists = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`
			if (exists.length > 0) await sql.unsafe(`DROP OWNED BY ${role}; DROP ROLE ${role}`)
		}
		await sql.close()
	})

	test("activates, and its launcher runs the pending reset before it migrates and verifies another workspace's schema", async () => {
		const { report, readiness } = await bootNewContainer(appId, async (root, database) => {
			// Workspace A's container applied a migration that workspace B, the commit this container holds, does not have.
			const extra = join(root, 'db/migrations/20991231000000_workspace_a.sql')
			writeFileSync(extra, 'CREATE TABLE workspace_a (id integer PRIMARY KEY);\n')
			expect((await sh(root, './node_modules/.bin/fabrika db migrate', database)).code).toBe(0)
			rmSync(extra)
		}, 1)
		expect(report).toEqual({ status: 'serving', reset: 1, message: null })
		expect(readiness).toBe(0)
		const sql = new SQL(POSTGRES_URL)
		const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = 'workspace_a'`
		await sql.close()
		expect(tables).toHaveLength(0)
	})

	test('activates over an applied migration that its commit edited, and its launcher reports the failure with reset_dev', async () => {
		const { report, readiness } = await bootNewContainer(appId, async (root, database) => {
			expect((await sh(root, './node_modules/.bin/fabrika db migrate', database)).code).toBe(0)
			const migration = join(root, NOTES_MIGRATION)
			writeFileSync(migration, `${readFileSync(migration, 'utf8')}\n-- edited after it was applied\n`)
		}, 0)
		expect(report?.status).toBe('failed')
		expect(report?.message).toContain('fabrika db migrate failed')
		expect(report?.message).toContain('reset_dev')
		expect(readiness).toBe(0)
	})
})
