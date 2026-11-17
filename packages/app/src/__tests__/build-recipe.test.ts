import { afterAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	contractChecks,
	contractRecipe,
	type ContractRecipeInput,
	FILE_SCAN_JOB,
	FILE_SWEEP_JOB,
	ISOLATION_TESTS_CHECK,
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

	test('the throwaway database runs after every other check: installed, started, migrated, verified, isolation-tested, stopped', () => {
		const steps = commands(contractRecipe(input))
		const index = steps.findIndex((step) => step.includes('postgresql18'))
		expect(index).toBe(steps.findIndex((step) => step.includes('fabrika-check /src')) + 1)
		const lines = (steps[index] ?? '').split('\n')
		const at = (fragment: string): number => lines.findIndex((line) => line.includes(fragment))
		const order = [
			'sudo apk add --no-cache --quiet postgresql18',
			'initdb ',
			'trap "pg_ctl',
			' start ',
			'fabrika db migrate',
			'fabrika db codegen --verify',
			'fabrika db test-isolation',
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
				`FABRIKA_APP_ID=notes ./node_modules/.bin/fabrika ${SCHEMA_TYPES_CHECK.join(' ')}`,
				`FABRIKA_APP_ID=notes exec ./node_modules/.bin/fabrika ${ISOLATION_TESTS_CHECK.join(' ')}`,
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

	test('are the checks and the tsconfig of the recipe', () => {
		const recipe = contractRecipe(input)
		const { tsconfig, checks } = contractChecks(input.sourceRoot, input.checkRelease)
		expect(recipe.checks).toEqual(checks)
		expect(recipe.build).toContainEqual(tsconfig)
		expect([SCHEMA_TYPES_CHECK, ISOLATION_TESTS_CHECK]).toEqual([['db', 'codegen', '--verify'], ['db', 'test-isolation']])
	})

	test('refuses a source root or a release a shell would read as more than one word', () => {
		expect(() => contractChecks('/work/a;id', '0.9.1')).toThrow('the source root must be an absolute path')
		expect(() => contractChecks('work/app', '0.9.1')).toThrow('the source root must be an absolute path')
		expect(() => contractChecks('/work/my app', '0.9.1')).toThrow('the source root must be an absolute path')
		expect(() => contractChecks('/work/app', '0.9.1 && id')).toThrow('the checker release must be a release version')
	})
})

// The build's throwaway database command, run by `sh` with stand-ins for `sudo`, `initdb`, `pg_ctl` and the CLI that log
// each call, so its order, its stop and its failures are observed without a PostgreSQL. Its directory moves under the
// test's own root, so parallel runs do not share it.
describe('the build schema checks command', () => {
	const roots: string[] = []
	afterAll(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true })
	})

	const stub = async (path: string, body: string): Promise<void> => {
		await writeFile(path, `#!/bin/sh\n${body}\n`)
		await chmod(path, 0o755)
	}

	const run = async (failing: string | null): Promise<{ code: number; stderr: string; calls: string[] }> => {
		const root = await mkdtemp(join(tmpdir(), 'fabrika-build-schema-checks-'))
		roots.push(root)
		const bin = join(root, 'bin')
		await mkdir(bin)
		await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
		const log = join(root, 'calls.log')
		const record = `echo "$(basename "$0") $*" >> ${log}`
		await stub(join(bin, 'sudo'), record)
		await stub(join(bin, 'initdb'), `${record}\nmkdir -p ${root}/postgres/data`)
		await stub(join(bin, 'pg_ctl'), record)
		await stub(
			join(root, 'node_modules', '.bin', 'fabrika'),
			`echo "fabrika $* url=$FABRIKA_APP_DATABASE_URL" >> ${log}\n[ "$2" = "${failing ?? ''}" ] && { echo "the $2 check failed" >&2; exit 1; }\nexit 0`,
		)
		const step = contractRecipe(input).build.find((candidate) => 'run' in candidate && candidate.run.includes('postgresql18'))
		if (step === undefined || !('run' in step)) throw new Error('expected the schema checks command')
		const child = Bun.spawn(['sh', '-c', step.run.replaceAll('/tmp/fabrika-build-postgres', `${root}/postgres`)], {
			cwd: root,
			env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
		const calls = (await readFile(log, 'utf8')).trim().replaceAll(root, '<root>').split('\n')
		return { code, stderr, calls }
	}

	test('starts the database, runs the three commands against it with a random password, and stops it', async () => {
		const { code, calls } = await run(null)
		expect(code).toBe(0)
		expect(calls.map((call) => call.split(' ').slice(0, 2).join(' '))).toEqual([
			'sudo apk',
			'initdb --pgdata=<root>/postgres/data',
			'pg_ctl --pgdata=<root>/postgres/data',
			'fabrika db',
			'fabrika db',
			'fabrika db',
			'pg_ctl --pgdata=<root>/postgres/data',
		])
		expect(calls.at(2)).toEndWith(' start')
		expect(calls.slice(3, 6).map((call) => call.split(' ')[2])).toEqual(['migrate', 'codegen', 'test-isolation'])
		expect(calls.at(3)).toMatch(/url=postgresql:\/\/fabrika:[0-9a-f]{32}@localhost\/postgres\?path=<root>\/postgres$/)
		expect(calls.at(-1)).toBe('pg_ctl --pgdata=<root>/postgres/data --mode=fast stop')
	})

	test('a failed check fails the command, names the check, skips the rest and still stops the database', async () => {
		const { code, stderr, calls } = await run('codegen')
		expect(code).toBe(1)
		expect(stderr).toContain('fabrika: the build check failed: schema types are stale (fabrika db codegen --verify)')
		expect(calls.some((call) => call.startsWith('fabrika db test-isolation'))).toBe(false)
		expect(calls.at(-1)).toBe('pg_ctl --pgdata=<root>/postgres/data --mode=immediate stop')
	})
})
