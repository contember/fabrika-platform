import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contractRecipe, type ContractRecipeInput, FILE_SCAN_JOB, FILE_SWEEP_JOB } from '../build'

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
		expect(index).toBe(steps.findIndex((step) => step.includes('fabrika-check /src')) + 1)
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
		expect(commands(recipe).some((step) => step.includes('postgresql18'))).toBe(false)
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
