import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	contractChecks,
	contractRecipe,
	type ContractRecipeInput,
	FILE_SCAN_JOB,
	FILE_SWEEP_JOB,
	PLATFORM_TYPESCRIPT_VERSION,
	SCHEMA_TYPES_CHECK,
} from '../build'

const input: ContractRecipeInput = {
	appId: 'notes',
	checkRelease: '0.9.1',
	sourceRoot: '/src',
	runtimeRoot: '/app',
	database: { schemaChecks: 'build' },
	sourceMaps: true,
	jobs: [{ name: 'digest', schedule: '0 6 * * *' }],
	files: true,
	scan: true,
}

const commands = (recipe: ReturnType<typeof contractRecipe>): string[] => recipe.build.map((step) => 'run' in step ? step.run : `write ${step.write}`)

describe('contractRecipe', () => {
	test('runs the authored tests before everything that produces or checks what deploys, and uploads source maps last', () => {
		const steps = commands(contractRecipe(input))
		const at = (fragment: string): number => steps.findIndex((step) => step.includes(fragment))
		expect(at("'test', '--isolate'")).toBe(1)
		expect(at('rm -rf node_modules')).toBeGreaterThan(at("'test', '--isolate'"))
		expect(at('writeGeneratedEntry')).toBeGreaterThan(at('rm -rf node_modules'))
		expect(at('tsc -p /src/fabrika/tsconfig.platform.json')).toBeGreaterThan(at('writeGeneratedEntry'))
		expect(at('fabrika-check /src')).toBeGreaterThan(at('tsc -p /src/fabrika/tsconfig.platform.json'))
		expect(steps.at(-1)).toBe('cd /tmp && bun x --bun -p @fabrika/check@0.9.1 fabrika-source-maps /src || true')
		expect(commands(contractRecipe({ ...input, sourceMaps: false })).some((step) => step.includes('fabrika-source-maps'))).toBe(false)
	})

	test("type-checks the SPA under web/ only for an application read with a 0.9 or later checker; an older one keeps 0.8's src/ check", () => {
		const included = (checkRelease: string): unknown => {
			const step = contractRecipe({ ...input, checkRelease }).build.find((candidate) =>
				'write' in candidate && candidate.write === 'fabrika/tsconfig.platform.json'
			)
			if (step === undefined || !('lines' in step)) throw new Error('the recipe writes no platform tsconfig')
			const parsed: unknown = JSON.parse(step.lines.join('\n'))
			return typeof parsed === 'object' && parsed !== null && 'include' in parsed ? parsed.include : undefined
		}
		const withWeb = ['../fabrika.contract.ts', '../src', '../web', 'entry.generated.ts']
		const withoutWeb = ['../fabrika.contract.ts', '../src', 'entry.generated.ts']
		for (const release of ['0.9.0', '0.9.0-dev.21', '0.9.1', '0.10.0', '1.0.0']) expect(included(release)).toEqual(withWeb)
		for (const release of ['0.4.8', '0.5.5', '0.6.0', '0.7.0', '0.8.2']) expect(included(release)).toEqual(withoutWeb)
	})

	test('a database migrates before the server starts and checks its schema in the build; without one nothing runs first', () => {
		const recipe = contractRecipe(input)
		expect(recipe.init).toEqual(['fabrika/migrate.generated.sh'])
		const migrate = recipe.build.find((step) => 'write' in step && step.write === 'fabrika/migrate.generated.sh')
		expect(migrate).toEqual({
			write: 'fabrika/migrate.generated.sh',
			lines: ['#!/bin/sh', 'set -eu', 'cd /app', 'FABRIKA_APP_ID=notes exec ./node_modules/.bin/fabrika db migrate'],
		})
		expect(commands(recipe)).not.toContain('write fabrika/verify.generated.sh')
		const none = contractRecipe({ ...input, database: false })
		expect(none.init).toEqual([])
		expect(commands(none).some((step) => step.includes('postgresql') || step.includes('db '))).toBe(false)
		expect(recipe.start).toBe('fabrika/start.generated.sh')
	})

	test('the throwaway database runs after every other check: installed, started, migrated, verified, stopped', () => {
		const steps = commands(contractRecipe(input))
		const index = steps.findIndex((step) => step.includes('postgresql18'))
		const checker = steps.findIndex((step) => step.includes('fabrika-check /src'))
		expect(steps[checker + 1]).toContain("release('@fabrika/cli')")
		expect(index).toBe(checker + 2)
		const lines = (steps[index] ?? '').split('\n')
		const at = (fragment: string): number => lines.findIndex((line) => line.includes(fragment))
		const order = [
			'sudo apk add --no-cache --quiet postgresql18',
			'trap "pg_ctl',
			'trap "exit 143" TERM',
			'printf %s "$PW"',
			'initdb ',
			' start ',
			'fabrika db migrate',
			'fabrika db codegen --verify',
			'--mode=fast stop',
		].map(at)
		expect(order.every((position) => position >= 0)).toBe(true)
		expect(order).toEqual([...order].sort((left, right) => left - right))
		expect(lines[0]).toBe('set -eu')
		// A unix socket only, behind a random password; nothing of the cluster under the source root.
		expect(lines[at('initdb ')]).toContain('--auth=scram-sha-256 --pwfile=/tmp/fabrika-build-postgres/password')
		expect(lines[at(' start ')]).toContain('-c listen_addresses= -c unix_socket_directories=/tmp/fabrika-build-postgres')
		expect(lines[at('FABRIKA_APP_DATABASE_URL')]).toBe(
			'export FABRIKA_APP_ID=notes FABRIKA_APP_DATABASE_URL="postgresql://fabrika:$PW@localhost/postgres?path=/tmp/fabrika-build-postgres"',
		)
		expect(steps[index]).not.toContain('${')
	})

	test('a build that cannot install the database checks the schema at every container start, after the migrations', () => {
		const recipe = contractRecipe({ ...input, database: { schemaChecks: 'init' } })
		expect(recipe.init).toEqual(['fabrika/migrate.generated.sh', 'fabrika/verify.generated.sh'])
		expect(recipe.build.find((step) => 'write' in step && step.write === 'fabrika/verify.generated.sh')).toEqual({
			write: 'fabrika/verify.generated.sh',
			lines: [
				'#!/bin/sh',
				'set -eu',
				'cd /app',
				'FABRIKA_APP_ID=notes exec ./node_modules/.bin/fabrika db codegen --verify',
			],
		})
		expect(commands(recipe).some((step) => step.includes('postgresql18') || step.includes('@fabrika/cli'))).toBe(false)
	})

	test("schedules the contract's jobs and the framework's file jobs only when the contract has files and scans", () => {
		expect(contractRecipe(input).jobs).toEqual([
			{ schedule: '0 6 * * *', command: './node_modules/.bin/fabrika job run digest' },
			{ schedule: '41 * * * *', command: `./node_modules/.bin/fabrika job run ${FILE_SWEEP_JOB}` },
			{ schedule: '* * * * *', command: `./node_modules/.bin/fabrika job run ${FILE_SCAN_JOB}` },
		])
		expect(contractRecipe({ ...input, jobs: [], files: false, scan: false }).jobs).toEqual([])
	})

	test('refuses a value a shell would read as more than one word', () => {
		expect(() => contractRecipe({ ...input, appId: 'notes; rm -rf /' })).toThrow('a contract application id must match')
		expect(() => contractRecipe({ ...input, checkRelease: '0.9.1 && curl evil' })).toThrow('the checker release must be a release version')
		expect(() => contractRecipe({ ...input, jobs: [{ name: 'digest $(id)', schedule: '0 6 * * *' }] })).toThrow('a job name or schedule')
		expect(() => contractRecipe({ ...input, jobs: [{ name: 'digest', schedule: '0 6 * * * ; id' }] })).toThrow('a job name or schedule')
	})
})

describe('contractChecks', () => {
	test('runs the tests, tsc over the platform tsconfig, then the checker at its release, from the source root', () => {
		const { tsconfig, checks } = contractChecks('/work/run/app', '0.9.1')
		expect(checks.map((check) => check.name)).toEqual(['tests', 'tsc', 'fabrika-check'])
		expect(checks[0].command).toContain("'test', '--isolate', '--pass-with-no-tests'")
		expect(checks[0].command).toContain('fabrika-tests:')
		expect(checks[1].command).toBe(
			`cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p /work/run/app/fabrika/tsconfig.platform.json`,
		)
		expect(checks[2].command).toBe('cd /tmp && bun x --bun -p @fabrika/check@0.9.1 fabrika-check /work/run/app')
		expect(tsconfig.write).toBe('fabrika/tsconfig.platform.json')
		expect(JSON.parse(tsconfig.lines.join('\n')).include).toContain('entry.generated.ts')
	})

	test('are the checks and the tsconfig of the recipe, and the schema-types check is its verify script in init mode', () => {
		const recipe = contractRecipe({ ...input, database: { schemaChecks: 'init' } })
		const { tsconfig, checks } = contractChecks(input.sourceRoot, input.checkRelease)
		expect(recipe.checks).toEqual(checks)
		expect(recipe.build).toContainEqual(tsconfig)
		const verify = recipe.build.find((step) => 'write' in step && step.write === 'fabrika/verify.generated.sh')
		expect(verify).toEqual({
			write: 'fabrika/verify.generated.sh',
			lines: [
				'#!/bin/sh',
				'set -eu',
				'cd /app',
				`FABRIKA_APP_ID=notes exec ./node_modules/.bin/fabrika ${SCHEMA_TYPES_CHECK.join(' ')}`,
			],
		})
		expect(SCHEMA_TYPES_CHECK).toEqual(['db', 'codegen', '--verify'])
	})

	test('refuses a source root or a release a shell would read as more than one word', () => {
		expect(() => contractChecks('/work/a;id', '0.9.1')).toThrow('the source root must be an absolute path')
		expect(() => contractChecks('work/app', '0.9.1')).toThrow('the source root must be an absolute path')
		expect(() => contractChecks('/work/my app', '0.9.1')).toThrow('the source root must be an absolute path')
		expect(() => contractChecks('/work/app', '0.9.1 && id')).toThrow('the checker release must be a release version')
	})
})

// The build's tests command, run by `sh` in a scratch application, as the build's shell runs it in the source root.
describe("the build's tests command", () => {
	const directories: string[] = []
	afterAll(async () => {
		await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
	})

	const run = async (release: string, files: Readonly<Record<string, string>>): Promise<{ readonly code: number; readonly stderr: string }> => {
		const directory = await mkdtemp(join(tmpdir(), 'fabrika-build-tests-'))
		directories.push(directory)
		for (const [name, text] of Object.entries(files)) {
			await mkdir(join(directory, name, '..'), { recursive: true })
			await writeFile(join(directory, name), text)
		}
		const [tests] = contractChecks('/src', release).checks
		const child = Bun.spawn(['sh', '-c', tests.command], { cwd: directory, env: { PATH: process.env['PATH'] ?? '' }, stdout: 'ignore', stderr: 'pipe' })
		const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
		return { code, stderr }
	}

	const PASSING = "import { expect, test } from 'bun:test'\ntest('passes', () => expect(1).toBe(1))\n"
	const FAILING = "import { expect, test } from 'bun:test'\ntest('fails', () => expect(1).toBe(2))\n"
	const manifest = (scripts: Readonly<Record<string, string>>): string => JSON.stringify({ name: 'notes', private: true, scripts })

	test("runs the application's own test script, with its paths and mode", async () => {
		const result = await run('0.9.1', {
			'package.json': manifest({ test: 'bun test --no-isolate src' }),
			'src/a.test.ts': PASSING,
			'tests/browser.test.ts': FAILING,
		})
		expect(result.stderr).toContain('fabrika-tests: runs the test script of package.json')
		expect(result.stderr).toContain('1 pass')
		expect(result.code).toBe(0)
	})

	test("fails the build when the application's test script fails, and still counts the skipped Postgres-backed files", async () => {
		const result = await run('0.9.1', {
			'package.json': manifest({ test: 'bun test src' }),
			'src/a.test.ts': `console.warn('a.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests')\n${PASSING}`,
			'src/b.test.ts': FAILING,
		})
		expect(result.code).not.toBe(0)
		expect(result.stderr).toContain('1 fail')
		expect(result.stderr).toContain('fabrika-tests: 1 Postgres-backed test files did not run, because the build has no database: a.test.ts')
	})

	test('runs bun test --isolate --pass-with-no-tests without a test script', async () => {
		// The first file leaves a global behind; only a run that isolates each file passes the second.
		const leaking = "import { expect, test } from 'bun:test'\ntest('leaks', () => { Reflect.set(globalThis, 'leaked', 1); expect(1).toBe(1) })\n"
		const checking = "import { expect, test } from 'bun:test'\ntest('is isolated', () => expect(Reflect.get(globalThis, 'leaked')).toBeUndefined())\n"
		const isolated = await run('0.9.1', { 'package.json': manifest({ build: 'exit 1' }), 'a.test.ts': leaking, 'b.test.ts': checking })
		expect(isolated.stderr).toContain('fabrika-tests: runs bun test --isolate --pass-with-no-tests')
		expect(isolated.stderr).toContain('2 pass')
		expect(isolated.code).toBe(0)
		const collected = await run('0.9.1', { 'package.json': manifest({}), 'a.test.ts': PASSING, 'tests/browser.test.ts': FAILING })
		expect(collected.code).not.toBe(0)
		const empty = await run('0.9.1', { 'package.json': manifest({}) })
		expect(empty.code).toBe(0)
		expect(empty.stderr).toContain('fabrika-tests: no Postgres-backed test file skipped')
		expect((await run('0.9.1', { 'a.test.ts': PASSING })).code).toBe(0)
	})

	test('an application before 0.9 keeps bun test --isolate and ignores its test script, as before', async () => {
		const result = await run('0.8.4', { 'package.json': manifest({ test: 'exit 7' }), 'a.test.ts': PASSING })
		expect(result.stderr).not.toContain('runs the test script')
		expect(result.stderr).toContain('1 pass')
		expect(result.code).toBe(0)
	})
})

// The build's throwaway database command, run by `sh` and BusyBox `sh` with stand-ins for `sudo`, `initdb`, `pg_ctl` and
// the CLI that log each call, so its order, its cleanup and its failures are observed without a PostgreSQL. Its
// directory moves under the test's own root, so parallel runs do not share it.
const BUSYBOX = Bun.which('busybox')
const SHELLS: readonly (readonly [label: string, command: readonly string[]])[] = [
	['sh', ['sh']],
	...(BUSYBOX === null ? [] : [['BusyBox sh', [BUSYBOX, 'sh']] as const]),
]
if (BUSYBOX === null) console.warn('build-recipe.test.ts: the BusyBox sh runs skipped; install busybox to run them')

describe.each(SHELLS)('the build schema checks command under %s', (_label, shell) => {
	const roots: string[] = []
	afterAll(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true })
	})

	const stub = async (path: string, body: string): Promise<void> => {
		await writeFile(path, `#!/bin/sh\n${body}\n`)
		await chmod(path, 0o755)
	}

	const readdirOrNull = (path: string): Promise<string[] | null> => readdir(path).catch(() => null)

	interface Run {
		/** The CLI command that fails, or `initdb`, or the fast stop. */
		readonly failing?: 'migrate' | 'codegen' | 'initdb' | 'fast-stop'
		/** Sends SIGTERM to the shell while `codegen --verify` runs. */
		readonly terminate?: true
	}

	const run = async (options: Run = {}): Promise<{ code: number; stderr: string; calls: string[]; left: boolean }> => {
		const root = await mkdtemp(join(tmpdir(), 'fabrika-build-schema-checks-'))
		roots.push(root)
		const bin = join(root, 'bin')
		await mkdir(bin)
		await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
		const log = join(root, 'calls.log')
		const record = `echo "$(basename "$0") $*" >> ${log}`
		await stub(join(bin, 'sudo'), record)
		await stub(join(bin, 'initdb'), `${record}\n${options.failing === 'initdb' ? 'exit 1' : `mkdir -p ${root}/postgres/data`}`)
		await stub(join(bin, 'pg_ctl'), `${record}\n${options.failing === 'fast-stop' ? 'case "$*" in *--mode=fast*) exit 1;; esac' : ''}`)
		await stub(
			join(root, 'node_modules', '.bin', 'fabrika'),
			[
				`echo "fabrika $* url=$FABRIKA_APP_DATABASE_URL" >> ${log}`,
				...(options.terminate === true ? [`[ "$2" = codegen ] && { touch ${root}/running; sleep 1; }`] : []),
				`[ "$2" = "${options.failing ?? ''}" ] && { echo "the $2 check failed" >&2; exit 1; }`,
				'exit 0',
			].join('\n'),
		)
		const step = contractRecipe(input).build.find((candidate) => 'run' in candidate && candidate.run.includes('postgresql18'))
		if (step === undefined || !('run' in step)) throw new Error('expected the schema checks command')
		const child = Bun.spawn([...shell, '-c', step.run.replaceAll('/tmp/fabrika-build-postgres', `${root}/postgres`)], {
			cwd: root,
			env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		if (options.terminate === true) {
			while (!(await Bun.file(join(root, 'running')).exists())) await Bun.sleep(20)
			child.kill('SIGTERM')
		}
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
		const calls = (await readFile(log, 'utf8')).trim().replaceAll(root, '<root>').split('\n')
		return {
			code,
			stderr,
			calls,
			left: (await readdirOrNull(join(root, 'postgres'))) !== null,
		}
	}

	const IMMEDIATE_STOP = 'pg_ctl --pgdata=<root>/postgres/data --mode=immediate stop'

	test('starts the database, runs the two commands against it with a random password, stops it and removes it', async () => {
		const { code, calls, left } = await run()
		expect(code).toBe(0)
		expect(calls.map((call) => call.split(' ').slice(0, 2).join(' '))).toEqual([
			'sudo apk',
			'initdb --pgdata=<root>/postgres/data',
			'pg_ctl --pgdata=<root>/postgres/data',
			'fabrika db',
			'fabrika db',
			'pg_ctl --pgdata=<root>/postgres/data',
			'pg_ctl --pgdata=<root>/postgres/data',
		])
		expect(calls.at(2)).toEndWith(' start')
		expect(calls.slice(3, 5).map((call) => call.split(' ')[2])).toEqual(['migrate', 'codegen'])
		expect(calls.at(3)).toMatch(/url=postgresql:\/\/fabrika:[0-9a-f]{32}@localhost\/postgres\?path=<root>\/postgres$/)
		expect(calls.at(5)).toBe('pg_ctl --pgdata=<root>/postgres/data --mode=fast stop')
		// The cleanup stays armed: its immediate stop finds nothing left to stop, and the directory goes.
		expect(calls.at(6)).toBe(IMMEDIATE_STOP)
		expect(left).toBe(false)
	})

	test('a failed check fails the command, names the check, stops the database and removes it', async () => {
		const { code, stderr, calls, left } = await run({ failing: 'codegen' })
		expect(code).toBe(1)
		expect(stderr).toContain('fabrika: the build check failed: schema types are stale (fabrika db codegen --verify)')
		expect(calls.some((call) => call.endsWith('--mode=fast stop'))).toBe(false)
		expect(calls.at(-1)).toBe(IMMEDIATE_STOP)
		expect(left).toBe(false)
	})

	test('a failed migration names itself and skips the schema check', async () => {
		const { code, stderr, calls, left } = await run({ failing: 'migrate' })
		expect(code).toBe(1)
		expect(stderr).toContain('fabrika: the build check failed: the migrations (fabrika db migrate)')
		expect(calls.some((call) => call.startsWith('fabrika db codegen'))).toBe(false)
		expect(calls.at(-1)).toBe(IMMEDIATE_STOP)
		expect(left).toBe(false)
	})

	test('a failed initdb fails the command and leaves no password file', async () => {
		const { code, calls, left } = await run({ failing: 'initdb' })
		expect(code).not.toBe(0)
		expect(calls.some((call) => call.startsWith('fabrika'))).toBe(false)
		expect(left).toBe(false)
	})

	test('a failed fast stop falls back to an immediate stop, and the passed checks still pass', async () => {
		const { code, calls, left } = await run({ failing: 'fast-stop' })
		expect(code).toBe(0)
		expect(calls.slice(-3)).toEqual(['pg_ctl --pgdata=<root>/postgres/data --mode=fast stop', IMMEDIATE_STOP, IMMEDIATE_STOP])
		expect(left).toBe(false)
	})

	test('SIGTERM stops the database and removes it', async () => {
		const { code, calls, left } = await run({ terminate: true })
		expect(code).toBe(143)
		expect(calls.at(-1)).toBe(IMMEDIATE_STOP)
		expect(calls.some((call) => call.endsWith('--mode=fast stop'))).toBe(false)
		expect(left).toBe(false)
	})
})

describe('the build check of the CLI release', () => {
	const roots: string[] = []
	afterAll(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true })
	})

	const run = async (releases: { readonly cli: string; readonly app: string }): Promise<{ code: number; stderr: string }> => {
		const root = await mkdtemp(join(tmpdir(), 'fabrika-build-cli-release-'))
		roots.push(root)
		for (const [name, version] of [['cli', releases.cli], ['app', releases.app]] as const) {
			await mkdir(join(root, 'node_modules', '@fabrika', name), { recursive: true })
			await writeFile(join(root, 'node_modules', '@fabrika', name, 'package.json'), JSON.stringify({ name: `@fabrika/${name}`, version }))
		}
		const step = contractRecipe(input).build.find((candidate) => 'run' in candidate && candidate.run.includes("release('@fabrika/cli')"))
		if (step === undefined || !('run' in step)) throw new Error('expected the CLI release check')
		const child = Bun.spawn(['sh', '-c', step.run], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
		return { code, stderr }
	}

	test('passes a CLI at the framework release or newer', async () => {
		expect((await run({ cli: '0.9.0-dev.23', app: '0.9.0-dev.23' })).code).toBe(0)
		expect((await run({ cli: '0.9.1', app: '0.9.0-dev.23' })).code).toBe(0)
	})

	test("refuses a CLI older than the framework, whose migrate would not check the live schema's code", async () => {
		const { code, stderr } = await run({ cli: '0.9.0-dev.22', app: '0.9.0-dev.23' })
		expect(code).toBe(1)
		expect(stderr.trim()).toBe(
			'fabrika: the build check failed: @fabrika/cli 0.9.0-dev.22 is older than @fabrika/app 0.9.0-dev.23; pin every @fabrika package to one release',
		)
	})
})
