// The `run` variant of a `dev` environment (ADR-0049, ADR-0043): the same checked build, with `run.start` running the dev
// launcher of the application's own release, init commands that verify only the bootstrap's files, and no health check
// that would restart a container whose launcher keeps running. The generated files are written by a real shell.

import { DEV_LAUNCHER_CONFIG_FILE, type DevLauncherConfig } from '@fabrika/auth-core'
import type { JsonValue } from '@fabrika/provider-contract'
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
	test('builds with every check, starts the launcher, and has no health check', () => {
		const ordinary = render(false)
		const dev = render(true)
		expect(mapping(dev['deploy'])).toEqual(mapping(ordinary['deploy']))
		const run = mapping(dev['run'])
		expect(run['start']).toBe('sh /var/www/fabrika/start.generated.sh')
		expect(run['initCommands']).toEqual(['sh /var/www/fabrika/dev-init.generated.sh'])
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

	test('the init commands migrate and verify a new container, and leave one the launcher already ran to the launcher', async () => {
		const root = applicationRoot()
		const written = generatedBuildCommands(execution(true), SPA).filter((command) => command.includes('.generated.sh'))
		for (const command of written) expect((await sh(root, command)).code).toBe(0)
		writeFileSync(join(root, 'fabrika/migrate.generated.sh'), 'echo migrated\n')
		writeFileSync(join(root, 'fabrika/verify.generated.sh'), 'echo verified\n')
		const init = generatedInitCommands(execution(true)).map((command) => command.replaceAll('/var/www', root))
		expect(init).toHaveLength(1)
		const script = readFileSync(join(root, 'fabrika/dev-init.generated.sh'), 'utf8').replaceAll('/var/www', root)
		writeFileSync(join(root, 'fabrika/dev-init.generated.sh'), script)
		const fresh = await sh(root, init[0] ?? '')
		expect(fresh).toMatchObject({ code: 0, stdout: 'migrated\nverified\n' })
		writeFileSync(join(root, 'fabrika/dev-state.json'), '{}')
		expect(existsSync(join(root, 'fabrika/dev-state.json'))).toBe(true)
		expect(await sh(root, init[0] ?? '')).toMatchObject({ code: 0, stdout: '' })
	})
})
