import {
	APPROVED_ACCESS_FILE_ENV,
	type CloudflareRunnerJob,
	cloudflareRunnerJobSchema,
	RUNNER_OUTCOME_FILE_ENV,
} from '@fabrika/provider-cloudflare/runner'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { contractDigest } from '../../../auth-core/src/endpoint-digest'
import { Runner, type RunnerEnv, type SpawnHandlers, type SpawnResult, type SpawnSpec } from '../runner'
import { bunSpawner, createSpawner } from '../spawn'

// The Runner routes every child process through an injected `Spawner`, so these tests drive a full
// checkout → install → fabrika-deploy pipeline with a fake. Real Git evidence lives in exact-source-git.test.ts.

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

interface RecordedSpawn {
	spec: SpawnSpec
}

/** A scripted spawner: emits canned stdout/stderr per command and returns a chosen exit code. */
const makeSpawner = (
	rec: RecordedSpawn[],
	script: (spec: SpawnSpec, handlers: SpawnHandlers) => SpawnResult,
) =>
async (spec: SpawnSpec, handlers: SpawnHandlers): Promise<SpawnResult> => {
	rec.push({ spec })
	const result = script(spec, handlers)
	if (spec.command === 'git' && spec.args[0] === 'log' && result.exitCode === 0) handlers.onStdout(`${COMMIT}\n`)
	return result
}

const baseJob = (overrides: Partial<CloudflareRunnerJob> = {}): CloudflareRunnerJob => ({
	runId: 'run-1',
	repoUrl: 'https://github.com/acme/app.git',
	ref: COMMIT,
	env: 'stage',
	runnerKey: 'test-runner-key',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc-123456', CLOUDFLARE_API_TOKEN: 'tok-abcdef' },
	approvedAccess: { kind: 'contract', contract: notesArtifact, contractDigest: contractDigest(notesArtifact) },
	...overrides,
})

const workspaces = new Set<string>()

afterEach(async () => {
	await Promise.all([...workspaces].map((workspace) => rm(workspace, { recursive: true, force: true })))
	workspaces.clear()
})

const makeEnv = (spawn: RunnerEnv['spawn']): RunnerEnv => {
	const workspace = mkdtempSync(join(tmpdir(), 'fabrika-runner-unit-'))
	workspaces.add(workspace)
	return { spawn, workspace }
}

describe('Runner pipeline', () => {
	test('exact checkout verifies HEAD before installing and does not log raw HEAD output', async () => {
		const rec: RecordedSpawn[] = []
		const env = makeEnv(makeSpawner(rec, () => ({ exitCode: 0 })))
		const runner = new Runner(baseJob(), env)
		const states: string[] = []
		runner.subscribe((line) => {
			if (line.text.startsWith('Git checkout verified:')) states.push(runner.status().state)
		})
		const status = await runner.run()
		expect(status.state).toBe('succeeded')
		expect(rec.slice(0, 4).map(({ spec }) => spec.args)).toEqual([
			['init', '--', runner.checkoutDir],
			['fetch', '--depth=1', '--no-tags', '--', 'https://github.com/acme/app.git', COMMIT],
			['switch', '--detach', '--', COMMIT],
			['log', '-1', '--format=%H', '--'],
		])
		expect(rec.slice(0, 4).map(({ spec }) => spec.cwd)).toEqual([env.workspace, runner.checkoutDir, runner.checkoutDir, runner.checkoutDir])
		expect(states).toEqual(['cloning'])
		const texts = runner.lines().map((line) => line.text)
		const witness = `Git checkout verified: expected=${COMMIT} actual=${COMMIT}`
		expect(texts).toContain(witness)
		expect(texts.indexOf(witness)).toBeLessThan(texts.indexOf(`Installing dependencies in ${runner.checkoutDir}`))
		expect(runner.lines().filter((line) => line.stream === 'stdout')).toEqual([])
	})

	test('non-dry mutable, abbreviated, uppercase and malformed refs are refused before Git', async () => {
		for (const ref of ['main', 'refs/heads/main', COMMIT.slice(0, 12), COMMIT.toUpperCase(), 'a'.repeat(64), `${COMMIT}\n`, `--${COMMIT}`, '']) {
			const rec: RecordedSpawn[] = []
			const status = await new Runner(baseJob({ ref }), makeEnv(makeSpawner(rec, () => ({ exitCode: 0 })))).run()
			expect(status.state).toBe('failed')
			expect(status.error).toBe('non-dry ref must be a complete lowercase 40-hex commit SHA')
			expect(rec).toEqual([])
		}
	})

	test('HEAD capture accepts chunked LF and CRLF and rejects malformed, mismatched or oversized output before Bun', async () => {
		const cases = [
			{ chunks: [COMMIT.slice(0, 17), `${COMMIT.slice(17)}\n`], exitCode: 0, error: undefined },
			{ chunks: [COMMIT, '\r', '\n'], exitCode: 0, error: undefined },
			{ chunks: [], exitCode: 0, error: 'git HEAD output is malformed' },
			{ chunks: [COMMIT], exitCode: 0, error: 'git HEAD output is malformed' },
			{ chunks: [`${COMMIT}\n${COMMIT}\n`], exitCode: 0, error: 'git HEAD output is malformed' },
			{ chunks: [` ${COMMIT}\n`], exitCode: 0, error: 'git HEAD output is malformed' },
			{ chunks: [`${COMMIT.toUpperCase()}\n`], exitCode: 0, error: 'git HEAD output is malformed' },
			{ chunks: ['b'.repeat(40) + '\n'], exitCode: 0, error: 'git checkout HEAD does not match the expected commit' },
			{ chunks: ['private-head-output\n'], exitCode: 0, error: 'git HEAD output is malformed' },
			{ chunks: [COMMIT + '\n'], exitCode: 128, error: 'git HEAD verification failed' },
			{ chunks: ['x'.repeat(128)], exitCode: 0, error: 'git HEAD output is malformed' },
			{ chunks: ['x'.repeat(64), 'x'.repeat(65)], exitCode: 0, error: 'git HEAD output exceeds the size limit' },
			{ chunks: ['é'.repeat(65)], exitCode: 0, error: 'git HEAD output exceeds the size limit' },
		]
		for (const input of cases) {
			const rec: SpawnSpec[] = []
			const runner = new Runner(
				baseJob(),
				makeEnv(async (spec, handlers) => {
					rec.push(spec)
					if (spec.command === 'git' && spec.args[0] === 'log') {
						for (const chunk of input.chunks) handlers.onStdout(chunk)
						handlers.onStderr('private-head-stderr\n')
						return { exitCode: input.exitCode }
					}
					return { exitCode: 0 }
				}),
			)
			const status = await runner.run()
			expect(status.state).toBe(input.error === undefined ? 'succeeded' : 'failed')
			expect(status.error).toBe(input.error)
			expect(rec.some((spec) => spec.command === 'bun')).toBe(input.error === undefined)
			const diagnostics = JSON.stringify({ status, lines: runner.lines() })
			expect(diagnostics).not.toContain('private-head-output')
			expect(diagnostics).not.toContain('private-head-stderr')
		}
	})

	test('a HEAD capture overflow waits for child termination and pipe cleanup before terminal failure', async () => {
		const killed = Promise.withResolvers<void>()
		const exit = Promise.withResolvers<number>()
		const drain = Promise.withResolvers<void>()
		const cancelling = Promise.withResolvers<void>()
		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('x'.repeat(129)))
			},
		})
		const stderr = new ReadableStream<Uint8Array>({
			cancel() {
				cancelling.resolve()
				return drain.promise
			},
		})
		const headSpawner = createSpawner(() => ({
			stdout,
			stderr,
			exited: exit.promise,
			kill(signal) {
				expect(signal).toBe('SIGKILL')
				killed.resolve()
			},
		}))
		const rec: SpawnSpec[] = []
		const runner = new Runner(
			baseJob(),
			makeEnv(async (spec, handlers) => {
				rec.push(spec)
				return spec.args[0] === 'log' ? headSpawner(spec, handlers) : { exitCode: 0 }
			}),
		)
		const run = runner.run()
		await killed.promise
		await cancelling.promise
		expect(runner.isDone()).toBe(false)
		expect(runner.status().state).toBe('cloning')
		exit.resolve(137)
		drain.resolve()
		const status = await run
		expect(status.error).toBe('git HEAD output exceeds the size limit')
		expect(rec.every((spec) => spec.command === 'git')).toBe(true)
		expect(stdout.locked).toBe(false)
		expect(stderr.locked).toBe(false)
	})

	test('each exact Git step failure refuses installation and artifact work without fallback', async () => {
		for (const failedStep of ['init', 'fetch', 'switch']) {
			const rec: RecordedSpawn[] = []
			let maps = false
			const runner = new Runner(baseJob(), {
				...makeEnv(makeSpawner(rec, (spec) => ({ exitCode: spec.args[0] === failedStep ? 128 : 0 }))),
				collectSourceMaps: async () => {
					maps = true
					return { artifacts: [], incomplete: false }
				},
			})
			const status = await runner.run()
			expect(status.error).toBe(`git ${failedStep} failed (exit 128)`)
			expect(rec.at(-1)?.spec.args[0]).toBe(failedStep)
			expect(rec.every(({ spec }) => spec.command === 'git')).toBe(true)
			expect(maps).toBe(false)
		}
	})

	test('Git userinfo authorization is URL-scoped child env for both fetch and mutable dry clone', async () => {
		const token = 'private/%:@+value'
		const clean = 'https://github.com/acme/app.git'
		const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
		const originalEnv = { ...process.env }
		for (const preview of [false, true]) {
			const rec: RecordedSpawn[] = []
			const runner = new Runner(
				baseJob({
					repoUrl: `https://x-access-token:${encodeURIComponent(token)}@github.com/acme/app.git`,
					...(preview ? { dryRun: true, ref: 'main' } : {}),
				}),
				makeEnv(makeSpawner(rec, () => ({ exitCode: 0 }))),
			)
			expect((await runner.run()).state).toBe('succeeded')
			const gitSpecs = rec.filter(({ spec }) => spec.command === 'git').map(({ spec }) => spec)
			for (const spec of gitSpecs) {
				expect(spec.env).toEqual({
					GIT_TERMINAL_PROMPT: '0',
					GIT_CONFIG_COUNT: '1',
					GIT_CONFIG_KEY_0: `http.${clean}.extraHeader`,
					GIT_CONFIG_VALUE_0: header,
				})
				expect(spec.args).not.toContain('-c')
			}
			expect(gitSpecs.find((spec) => spec.args[0] === (preview ? 'clone' : 'fetch'))?.args).toContain(clean)
			for (const { spec } of rec) {
				expect(spec.args.join(' ')).not.toContain(token)
				expect(spec.args.join(' ')).not.toContain(encodeURIComponent(token))
				expect(spec.args.join(' ')).not.toContain(header)
				if (spec.command !== 'git') {
					expect(Object.keys(spec.env ?? {}).some((key) => key.startsWith('GIT_'))).toBe(false)
					expect(JSON.stringify(spec.env ?? {})).not.toContain(token)
				}
			}
		}
		expect(process.env).toEqual(originalEnv)
	})

	test('raw, encoded, decoded and derived Git credentials, including short tokens, are redacted across chunks and residual boundaries', async () => {
		for (const token of ['private/%:@+value', 'q!', 'q']) {
			const encoded = encodeURIComponent(token)
			const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
			const header = `Authorization: Basic ${basic}`
			const values = [token, encoded, `x-access-token:${token}`, basic, `Basic ${basic}`, header]
			const rec: RecordedSpawn[] = []
			const runner = new Runner(
				baseJob({ repoUrl: `https://x-access-token:${encoded}@github.com/acme/app.git` }),
				makeEnv(makeSpawner(rec, (spec, handlers) => {
					if (spec.args[0] === 'fetch') {
						for (const value of values) {
							const cut = Math.max(1, Math.floor(value.length / 2))
							handlers.onStderr(`credential=${value.slice(0, cut)}`)
							handlers.onStderr(`${value.slice(cut)} rejected\n`)
							for (const emit of [handlers.onStdout, handlers.onStderr]) {
								emit('y'.repeat(64 * 1024) + value.slice(0, cut))
								emit(`${value.slice(cut)} end\n`)
							}
						}
						handlers.onStderr(`residual=${header}`)
					}
					return { exitCode: 0 }
				})),
			)
			expect((await runner.run()).state).toBe('succeeded')
			const diagnostics = JSON.stringify({ status: runner.status(), lines: runner.lines() })
			for (const value of values) expect(diagnostics).not.toContain(value)
			expect(runner.lines().filter((line) => line.stream === 'stdout').map((line) => line.text).join(''))
				.toBe(('y'.repeat(64 * 1024) + '*** end').repeat(values.length))
			expect(runner.lines().filter((line) => line.stream === 'stderr').map((line) => line.text).join('')).toContain('residual=***')
		}
	})

	test('an unfinished credential longer than the logging cap cannot grow the residual or leak its prefix', async () => {
		const token = 's'.repeat(128 * 1024)
		const runner = new Runner(
			baseJob({ secrets: { LONG_SECRET: token } }),
			makeEnv(makeSpawner([], (spec, handlers) => {
				if (spec.command === 'fabrika-cloudflare-executor') {
					handlers.onStdout(token.slice(0, 64 * 1024 + 1))
					handlers.onStdout(token.slice(64 * 1024 + 1) + '\nnext line\n')
				}
				return { exitCode: 0 }
			})),
		)
		expect((await runner.run()).state).toBe('succeeded')
		expect(runner.lines().filter((line) => line.stream === 'stdout').map((line) => line.text)).toEqual([
			'*** [unfinished log line exceeds the size limit]',
			'next line',
		])
	})

	test('32 admitted 32-KiB secrets construct a Runner, reach a real child env and are all redacted', async () => {
		const secrets: Record<string, string> = {}
		for (let index = 0; index < 32; index++) {
			const prefix = `large-secret-${index}-`
			secrets[`LARGE_SECRET_${index}`] = prefix + 'v'.repeat(32 * 1024 - prefix.length)
		}
		const job = baseJob({ runId: '0198d922-06f6-7000-8000-000000000002', secrets })
		expect(cloudflareRunnerJobSchema.safeParse(job).success).toBe(true)
		let children = 0
		const runner = new Runner(
			job,
			makeEnv(async (spec, handlers) => {
				if (spec.command === 'git' && spec.args[0] === 'log') handlers.onStdout(`${COMMIT}\n`)
				if (spec.command !== 'fabrika-cloudflare-executor') return { exitCode: 0 }
				children++
				return bunSpawner({
					command: process.execPath,
					args: [
						'-e',
						`
					const keys = Object.keys(process.env).filter(key => key.startsWith('LARGE_SECRET_'))
					if (keys.length !== 32) process.exit(2)
					for (const key of keys) console.log('secret=' + process.env[key])
				`,
					],
					cwd: spec.cwd,
					env: spec.env,
				}, handlers)
			}),
		)
		const status = await runner.run()
		expect(status.state).toBe('succeeded')
		expect(children).toBe(1)
		expect(runner.isDone()).toBe(true)
		expect(runner.lines().filter((line) => line.stream === 'stdout').map((line) => line.text)).toEqual(Array.from({ length: 32 }, () => 'secret=***'))
		const diagnostics = JSON.stringify({ status, lines: runner.lines() })
		for (const value of Object.values(secrets)) expect(diagnostics).not.toContain(value)
	})

	test('literal redaction preserves the leftmost match and chooses the longest value at that position', async () => {
		const runner = new Runner(
			baseJob({ secrets: { LONG: 'abcde', SHORT: 'abcd', SHIFTED: 'bcdefg' } }),
			makeEnv(makeSpawner([], (spec, handlers) => {
				if (spec.command === 'fabrika-cloudflare-executor') handlers.onStdout('abcde abcd bcdefg abcdefg\n')
				return { exitCode: 0 }
			})),
		)
		expect((await runner.run()).state).toBe('succeeded')
		expect(runner.lines().filter((line) => line.stream === 'stdout').map((line) => line.text)).toEqual(['*** *** *** ***fg'])
	})

	test('a real child with chatty 128-KiB lines redacts a one-character Git token with absent large secrets', async () => {
		const secrets: Record<string, string> = {}
		for (let index = 0; index < 32; index++) secrets[`ABSENT_SECRET_${index}`] = `absent-${index}-` + 'v'.repeat(32 * 1024)
		const job = baseJob({
			runId: '0198d922-06f6-7000-8000-000000000003',
			repoUrl: 'https://x-access-token:q@github.com/acme/app.git',
			secrets,
		})
		expect(cloudflareRunnerJobSchema.safeParse(job).success).toBe(true)
		const runner = new Runner(
			job,
			makeEnv(async (spec, handlers) => {
				if (spec.command === 'git' && spec.args[0] === 'log') handlers.onStdout(`${COMMIT}\n`)
				if (spec.command !== 'fabrika-cloudflare-executor') return { exitCode: 0 }
				return bunSpawner({
					command: process.execPath,
					args: ['-e', "process.stdout.write('q'.repeat(128 * 1024) + '\\n'); process.stderr.write('q'.repeat(128 * 1024))"],
					cwd: spec.cwd,
					env: spec.env,
				}, handlers)
			}),
		)
		expect((await runner.run()).state).toBe('succeeded')
		for (const stream of ['stdout', 'stderr']) {
			expect(runner.lines().filter((line) => line.stream === stream).map((line) => line.text).join('')).toBe('***'.repeat(128 * 1024))
		}
	})

	test('clone → install → deploy: faithful argv + cwd, success status with exit 0', async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, (spec, handlers) => {
			handlers.onStdout(`ran ${spec.command}\n`)
			return { exitCode: 0 }
		})
		const runner = new Runner(baseJob({ ref: 'main', workerDir: 'worker', configPath: 'fabrika.config.ts', dryRun: true }), makeEnv(spawn))
		const status = await runner.run()

		expect(rec.map((r) => r.spec.command)).toEqual(['git', 'bun', 'fabrika-cloudflare-executor'])
		// clone into the run-keyed checkout dir
		expect(rec[0]?.spec.args).toEqual(['clone', '--depth', '1', '--branch', 'main', '--', 'https://github.com/acme/app.git', runner.checkoutDir])
		// install + deploy run in workerDir
		expect(rec[1]?.spec).toMatchObject({ command: 'bun', args: ['install'], cwd: `${runner.checkoutDir}/worker` })
		// deploy is faithful to M1's CLI contract
		expect(rec[2]?.spec).toMatchObject({
			command: 'fabrika-cloudflare-executor',
			args: ['deploy', '--env=stage', '--config=fabrika.config.ts', '--dry-run'],
			cwd: `${runner.checkoutDir}/worker`,
		})

		expect(status.state).toBe('succeeded')
		expect(status.exitCode).toBe(0)
		expect(typeof status.finishedAt).toBe('number')
	})

	test('strips refs/heads|tags/ from the ref for `git clone --branch` (a short name passes through)', async () => {
		const recHeads: RecordedSpawn[] = []
		const runner = new Runner(baseJob({ ref: 'refs/heads/main', dryRun: true }), makeEnv(makeSpawner(recHeads, () => ({ exitCode: 0 }))))
		await runner.run()
		expect(recHeads[0]?.spec.args).toEqual(['clone', '--depth', '1', '--branch', 'main', '--', 'https://github.com/acme/app.git', runner.checkoutDir])

		const recTags: RecordedSpawn[] = []
		await new Runner(baseJob({ ref: 'refs/tags/v1.2.3', dryRun: true }), makeEnv(makeSpawner(recTags, () => ({ exitCode: 0 })))).run()
		expect(recTags[0]?.spec.args[4]).toBe('v1.2.3')
	})

	test('redacts + strips a private-repo install token from the clone URL in every log line', async () => {
		const token = 'ghs_supersecrettoken1234567890'
		const spawn = makeSpawner([], (_spec, handlers) => {
			// Simulate git echoing the full URL on an error — the token must not survive into the log.
			handlers.onStderr(`fatal: could not read from https://x-access-token:${token}@github.com/acme/app\n`)
			return { exitCode: 0 }
		})
		const runner = new Runner(
			baseJob({ ref: 'main', repoUrl: `https://x-access-token:${token}@github.com/acme/app.git`, dryRun: true }),
			makeEnv(spawn),
		)
		await runner.run()
		const lines = runner.lines()
		expect(lines.map((l) => l.text).join('\n')).not.toContain(token)
		// The clone meta line shows the repo WITHOUT the userinfo (token), not just a masked one.
		expect(lines.some((l) => l.text === 'Cloning https://github.com/acme/app.git @ main')).toBe(true)
	})

	test('credentials, secrets, vars, managed environment and state namespace go into child env only', async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, () => ({ exitCode: 0 }))
		const job = baseJob({
			domain: 'stage.acme.com',
			returnOrigins: ['https://app.acme.com', 'https://stage.acme.com'],
			stateNamespace: 'legacy-state',
			runnerKey: 'test-runner-key',
			credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc-123456', CLOUDFLARE_API_TOKEN: 'tok-abcdef' },
			secrets: { SAMPLE_API_KEY: 'super-secret-value' },
			vars: { PUBLIC_ORIGIN: 'public-value' },
			managedEnvironment: {
				FABRIKA_OPERATIONS_DSN: 'https://operations-public-key@errors.test/1',
				FABRIKA_RELEASE: 'fabrika/app/stage/default/commit',
			},
		})
		await new Runner(job, makeEnv(spawn)).run()

		const deploy = rec.find((r) => r.spec.command === 'fabrika-cloudflare-executor')?.spec
		expect(deploy?.env).toMatchObject({
			CLOUDFLARE_ACCOUNT_ID: 'acc-123456',
			CLOUDFLARE_API_TOKEN: 'tok-abcdef',
			FABRIKA_CONTROL_DOMAIN: 'stage.acme.com',
			FABRIKA_IAM_RETURN_ORIGINS: 'https://app.acme.com,https://stage.acme.com',
			CLOUDFLARE_STATE_NAMESPACE: 'legacy-state',
			SAMPLE_API_KEY: 'super-secret-value',
			PUBLIC_ORIGIN: 'public-value',
			FABRIKA_OPERATIONS_DSN: 'https://operations-public-key@errors.test/1',
			FABRIKA_RELEASE: 'fabrika/app/stage/default/commit',
		})
		expect(deploy?.args).toContain('--managed-var=FABRIKA_OPERATIONS_DSN')
		expect(deploy?.args).toContain('--managed-var=FABRIKA_RELEASE')
		// No secret/cred value ever appears on argv.
		const argvAll = rec.flatMap((r) => r.spec.args).join(' ')
		expect(argvAll).not.toContain('super-secret-value')
		expect(argvAll).not.toContain('tok-abcdef')
		expect(argvAll).not.toContain('public-value')
		expect(argvAll).not.toContain('operations-public-key')
		expect(argvAll).not.toContain('fabrika/app/stage/default/commit')
	})

	test("Control's registry reaches the executor as JSON, and no job-supplied name replaces or plants it", async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, () => ({ exitCode: 0 }))
		const executorEnv = async (job: CloudflareRunnerJob) => {
			rec.length = 0
			await new Runner(job, makeEnv(spawn)).run()
			return rec.find((r) => r.spec.command === 'fabrika-cloudflare-executor')?.spec.env
		}

		const sent = await executorEnv(baseJob({ installationApps: ['app@stage', 'notes@prod'], secrets: { FABRIKA_INSTALLATION_APPS: '[]' } }))
		expect(sent?.['FABRIKA_INSTALLATION_APPS']).toBe('["app@stage","notes@prod"]')

		const absent = await executorEnv(baseJob({ vars: { FABRIKA_INSTALLATION_APPS: '[]' } }))
		expect(absent).not.toHaveProperty('FABRIKA_INSTALLATION_APPS')
	})

	test("the environment's cross origins reach the executor as JSON, and no job-supplied name replaces or plants them", async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, () => ({ exitCode: 0 }))
		const executorEnv = async (job: CloudflareRunnerJob) => {
			rec.length = 0
			await new Runner(job, makeEnv(spawn)).run()
			return rec.find((r) => r.spec.command === 'fabrika-cloudflare-executor')?.spec.env
		}

		const sent = await executorEnv(
			baseJob({ crossOrigins: ['https://partner.example.org'], secrets: { FABRIKA_CROSS_ORIGINS: '["https://evil.example"]' } }),
		)
		expect(sent?.['FABRIKA_CROSS_ORIGINS']).toBe('["https://partner.example.org"]')

		const absent = await executorEnv(baseJob({ vars: { FABRIKA_CROSS_ORIGINS: '["https://evil.example"]' } }))
		expect(absent).not.toHaveProperty('FABRIKA_CROSS_ORIGINS')
	})

	test('credential, secret, var and managed environment values are redacted from log lines', async () => {
		const spawn = makeSpawner([], (spec, handlers) => {
			if (spec.command === 'fabrika-cloudflare-executor') {
				handlers.onStdout(
					'deploying with token tok-abcdef, key super-secret-value, var public-value and dsn https://operations-public-key@errors.test/1\n',
				)
			}
			return { exitCode: 0 }
		})
		const job = baseJob({
			secrets: { SAMPLE_API_KEY: 'super-secret-value' },
			vars: { PUBLIC_ORIGIN: 'public-value' },
			managedEnvironment: { FABRIKA_OPERATIONS_DSN: 'https://operations-public-key@errors.test/1' },
		})
		const runner = new Runner(job, makeEnv(spawn))
		await runner.run()

		const joined = runner.lines().map((l) => l.text).join('\n')
		expect(joined).not.toContain('tok-abcdef')
		expect(joined).not.toContain('super-secret-value')
		expect(joined).not.toContain('public-value')
		expect(joined).not.toContain('operations-public-key')
		expect(joined).toContain('***')
	})

	test('a credential split across two stream chunks is redacted once the line is assembled', async () => {
		const token = 'tok-abcdefghijklmnop'
		const spawn = makeSpawner([], (spec, handlers) => {
			if (spec.command === 'fabrika-cloudflare-executor') {
				// One logical line delivered as two pipe reads, cut INSIDE the credential.
				handlers.onStdout('error: token tok-abcdefgh')
				handlers.onStdout('ijklmnop rejected\n')
			}
			return { exitCode: 0 }
		})
		const runner = new Runner(baseJob({ credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc-123456', CLOUDFLARE_API_TOKEN: token } }), makeEnv(spawn))
		await runner.run()

		const joined = runner.lines().map((l) => l.text).join('\n')
		expect(joined).not.toContain(token)
		expect(joined).not.toContain('tok-abcdefgh')
		expect(joined).not.toContain('ijklmnop')
		expect(joined).toContain('error: token *** rejected')
	})

	test('a final line without a trailing newline is emitted once, redacted', async () => {
		const spawn = makeSpawner([], (spec, handlers) => {
			if (spec.command === 'fabrika-cloudflare-executor') {
				handlers.onStdout('last line with tok-abcdef')
			}
			return { exitCode: 0 }
		})
		const runner = new Runner(baseJob(), makeEnv(spawn))
		await runner.run()

		const texts = runner.lines().filter((l) => l.stream === 'stdout').map((l) => l.text)
		expect(texts).toEqual(['last line with ***'])
	})

	test('a residual past the cap is emitted instead of growing without bound', async () => {
		const overCap = 'y'.repeat(64 * 1024 + 1)
		const spawn = makeSpawner([], (spec, handlers) => {
			if (spec.command === 'fabrika-cloudflare-executor') {
				handlers.onStdout(overCap)
				handlers.onStdout('tail\n')
			}
			return { exitCode: 0 }
		})
		const runner = new Runner(baseJob(), makeEnv(spawn))
		await runner.run()

		const texts = runner.lines().filter((l) => l.stream === 'stdout').map((l) => l.text)
		expect(texts.join('')).toBe(`${overCap}tail`)
		expect(texts.length).toBeGreaterThan(1)
	})

	test('refuses a runId that is not a single safe path segment before spawning anything', async () => {
		for (const runId of ['../x', 'a/b', '']) {
			const rec: RecordedSpawn[] = []
			const status = await new Runner(baseJob({ runId }), makeEnv(makeSpawner(rec, () => ({ exitCode: 0 })))).run()
			expect(rec).toEqual([])
			expect(status.state).toBe('failed')
			expect(status.error).toContain('runId')
		}
	})

	test('refuses an escaping workerDir or configPath before spawning anything', async () => {
		for (const overrides of [{ workerDir: '../x' }, { workerDir: '/etc' }, { configPath: '/etc/passwd' }, { configPath: '../../evil.ts' }]) {
			const rec: RecordedSpawn[] = []
			const status = await new Runner(baseJob(overrides), makeEnv(makeSpawner(rec, () => ({ exitCode: 0 })))).run()
			expect(rec).toEqual([])
			expect(status.state).toBe('failed')
			expect(status.error).toContain('inside the checkout')
		}
	})

	test('clone failure stops the pipeline (no install/deploy) and fails the run', async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, (spec) => ({ exitCode: spec.command === 'git' ? 128 : 0 }))
		const status = await new Runner(baseJob({ ref: 'main', dryRun: true }), makeEnv(spawn)).run()

		expect(rec.map((r) => r.spec.command)).toEqual(['git'])
		expect(status.state).toBe('failed')
		expect(status.error).toContain('git clone failed')
		expect(status.exitCode).toBeUndefined()
	})

	test('a rejected clone, install or deploy becomes a credential-safe terminal failure', async () => {
		for (const command of ['git', 'bun', 'fabrika-cloudflare-executor']) {
			const rec: RecordedSpawn[] = []
			const spawn = makeSpawner(rec, (spec) => {
				if (spec.command === command) throw new Error('spawn rejected: https://x-access-token:private-token@host/app tok-abcdef')
				return { exitCode: 0 }
			})
			const runner = new Runner(baseJob(), makeEnv(spawn))
			const status = await runner.run()
			expect(status.state).toBe('failed')
			expect(status.error).toBe('runner execution failed unexpectedly')
			expect(status.exitCode).toBeUndefined()
			expect(typeof status.finishedAt).toBe('number')
			expect(runner.isDone()).toBe(true)
			expect(rec.at(-1)?.spec.command).toBe(command)
			const diagnostics = JSON.stringify({ status, lines: runner.lines() })
			expect(diagnostics).not.toContain('private-token')
			expect(diagnostics).not.toContain('tok-abcdef')
			expect(diagnostics).not.toContain('spawn rejected')
		}
	})

	test('observer failures in progress, child output or residuals cannot defeat terminal failure', async () => {
		for (const failureAt of ['progress', 'output', 'residual']) {
			const rec: RecordedSpawn[] = []
			const runner = new Runner(
				baseJob(),
				makeEnv(makeSpawner(rec, (_spec, handlers) => {
					handlers.onStdout(failureAt === 'residual' ? 'child output' : 'child output\n')
					return { exitCode: 0 }
				})),
			)
			let terminalDiagnosticSeen = false
			runner.subscribe((line) => {
				if (line.text === 'runner execution failed unexpectedly') {
					expect(runner.isDone()).toBe(true)
					expect(runner.status().state).toBe('failed')
					terminalDiagnosticSeen = true
					throw new Error('diagnostic observer private-token')
				}
				if ((failureAt === 'progress' && line.stream === 'meta') || line.stream === 'stdout') {
					throw new Error('observer private-token')
				}
			})
			const seen: string[] = []
			runner.subscribe((line) => seen.push(line.text))
			const status = await runner.run()
			expect(status.error).toBe('runner execution failed unexpectedly')
			expect(terminalDiagnosticSeen).toBe(true)
			expect(seen).toContain('runner execution failed unexpectedly')
			expect(rec.map(({ spec }) => spec.command)).toEqual(failureAt === 'progress' ? [] : ['git'])
			expect(JSON.stringify(runner.lines())).not.toContain('private-token')
		}
	})

	test('non-zero provider deploy exit fails the run and carries the exit code', async () => {
		const spawn = makeSpawner([], (spec) => ({ exitCode: spec.command === 'fabrika-cloudflare-executor' ? 1 : 0 }))
		const status = await new Runner(baseJob(), makeEnv(spawn)).run()
		expect(status.state).toBe('failed')
		expect(status.exitCode).toBe(1)
	})

	test('subscribers receive streamed lines live', async () => {
		const seen: string[] = []
		const spawn = makeSpawner([], (spec, handlers) => {
			if (spec.command === 'fabrika-cloudflare-executor') {
				handlers.onStdout('line-a\nline-b\n')
			}
			return { exitCode: 0 }
		})
		const runner = new Runner(baseJob(), makeEnv(spawn))
		runner.subscribe((line) => {
			if (line.stream === 'stdout') {
				seen.push(line.text)
			}
		})
		await runner.run()
		expect(seen).toContain('line-a')
		expect(seen).toContain('line-b')
	})

	test('uploads discovered Cloudflare source maps without changing deploy success', async () => {
		const requests: Request[] = []
		const bytes = new TextEncoder().encode('{"version":3}')
		const body = new ArrayBuffer(bytes.byteLength)
		new Uint8Array(body).set(bytes)
		const job = baseJob({
			artifactUpload: {
				url: 'https://operations.test/api/artifacts/source-maps/',
				bearer: 'a'.repeat(64),
				appId: 'app',
				environment: 'stage',
				serviceKey: 'default',
				release: `fabrika/app/stage/default/${'b'.repeat(40)}`,
				runId: 'run-1',
			},
		})
		const runner = new Runner(job, {
			...makeEnv(makeSpawner([], () => ({ exitCode: 0 }))),
			collectSourceMaps: () =>
				Promise.resolve({
					artifacts: [{ logicalPath: 'assets/app.js', digest: 'c'.repeat(64), body }],
					incomplete: false,
				}),
			fetch: (input, init) => {
				requests.push(new Request(input, init))
				return Promise.resolve(new Response(null, { status: 201 }))
			},
		})

		const status = await runner.run()
		expect(status.state).toBe('succeeded')
		expect(status.artifactState).toBe('complete')
		expect(requests).toHaveLength(1)
		expect(requests[0]?.headers.get('X-Fabrika-Artifact-Path')).toBe('assets/app.js')
		expect(requests[0]?.headers.get('X-Fabrika-Artifact-Sha256')).toBe('c'.repeat(64))
	})

	test('records an unavailable artifact upload as incomplete without failing deploy', async () => {
		const job = baseJob({
			artifactUpload: {
				url: 'https://operations.test/api/artifacts/source-maps/',
				bearer: 'a'.repeat(64),
				appId: 'app',
				environment: 'stage',
				serviceKey: 'default',
				release: `fabrika/app/stage/default/${'b'.repeat(40)}`,
				runId: 'run-1',
			},
		})
		const status = await new Runner(job, {
			...makeEnv(makeSpawner([], () => ({ exitCode: 0 }))),
			collectSourceMaps: () => Promise.reject(new Error('scan unavailable')),
		}).run()
		expect(status.state).toBe('succeeded')
		expect(status.artifactState).toBe('incomplete')
	})

	test('an artifact diagnostic observer failure is owned by run(), not mistaken for optional upload failure', async () => {
		const runner = new Runner(
			baseJob({
				artifactUpload: {
					url: 'https://operations.test/api/artifacts/source-maps/',
					bearer: 'a'.repeat(64),
					appId: 'app',
					environment: 'stage',
					serviceKey: 'default',
					release: `fabrika/app/stage/default/${'b'.repeat(40)}`,
					runId: 'run-1',
				},
			}),
			{
				...makeEnv(makeSpawner([], () => ({ exitCode: 0 }))),
				collectSourceMaps: () => Promise.resolve({ artifacts: [], incomplete: false }),
			},
		)
		runner.subscribe((line) => {
			if (line.text.startsWith('Operations source maps:')) throw new Error('observer private-token')
		})
		const status = await runner.run()
		expect(status.state).toBe('failed')
		expect(status.error).toBe('runner execution failed unexpectedly')
		expect(status.artifactState).toBe('complete')
		expect(runner.isDone()).toBe(true)
	})
})

describe('executor outcome file', () => {
	/** A spawner that hands the executor's outcome file whatever `write` produces, in a real workspace. */
	const runWithOutcome = async (
		workspace: string,
		write: (path: string) => Promise<void>,
		deployExitCode = 0,
		dryRun = false,
	): Promise<{ status: Awaited<ReturnType<Runner['run']>>; outcomePath: string | undefined }> => {
		let outcomePath: string | undefined
		const spawn = async (spec: SpawnSpec, handlers: SpawnHandlers): Promise<SpawnResult> => {
			if (spec.command === 'git' && spec.args[0] === 'log') handlers.onStdout(`${COMMIT}\n`)
			const path = spec.env?.[RUNNER_OUTCOME_FILE_ENV]
			if (spec.command !== 'fabrika-cloudflare-executor') return { exitCode: 0 }
			if (path !== undefined) {
				outcomePath = path
				await write(path)
			}
			return { exitCode: deployExitCode }
		}
		const status = await new Runner(baseJob(dryRun ? { dryRun: true } : {}), { spawn, workspace }).run()
		return { status, outcomePath }
	}

	const withWorkspace = async (body: (workspace: string) => Promise<void>): Promise<void> => {
		const workspace = await mkdtemp(join(tmpdir(), 'fabrika-runner-outcome-'))
		try {
			await body(workspace)
		} finally {
			await rm(workspace, { recursive: true, force: true })
		}
	}

	test('a valid iamReconcile lands in status(), outside the checkout, and the file is deleted', async () => {
		await withWorkspace(async (workspace) => {
			const reconcile = { app: 'shop', schemaJson: '{"roles":[]}' }
			const { status, outcomePath } = await runWithOutcome(workspace, (path) => writeFile(path, JSON.stringify({ iamReconcile: reconcile })))

			expect(status.state).toBe('succeeded')
			expect(status.iamReconcile).toEqual(reconcile)
			expect(outcomePath).toBe(join(workspace, 'run-1.outcome.json'))
			expect(await Bun.file(join(workspace, 'run-1.outcome.json')).exists()).toBe(false)
		})
	})

	test("a refused deploy carries no IAM reconcile, and a succeeded one carries the executor's; artifact access is dropped", async () => {
		// What an executor from before applications without a contract were refused could still write.
		const outcome = {
			artifactAccess: { state: 'deployed', accessJson: '{"gates":null,"schema":null}' },
			iamReconcile: { app: 'shop', schemaJson: '{}' },
		}
		await withWorkspace(async (workspace) => {
			const failed = await runWithOutcome(workspace, (path) => writeFile(path, JSON.stringify(outcome)), 1)
			expect(failed.status.iamReconcile).toBeUndefined()
			expect(failed.status).not.toHaveProperty('artifactAccess')
		})
		await withWorkspace(async (workspace) => {
			const succeeded = await runWithOutcome(workspace, (path) => writeFile(path, JSON.stringify(outcome)))
			expect(succeeded.status).toMatchObject({ state: 'succeeded', iamReconcile: outcome.iamReconcile })
			expect(succeeded.status).not.toHaveProperty('artifactAccess')
		})
	})

	test('a dry run reports no reconcile even when the checkout wrote an outcome file', async () => {
		await withWorkspace(async (workspace) => {
			const reconcile = { app: 'shop', schemaJson: '{"roles":[]}' }
			const { status } = await runWithOutcome(workspace, (path) => writeFile(path, JSON.stringify({ iamReconcile: reconcile })), 0, true)
			expect(status.state).toBe('succeeded')
			expect(status.dryRun).toBe(true)
			expect(status.iamReconcile).toBeUndefined()
			expect(await Bun.file(join(workspace, 'run-1.outcome.json')).exists()).toBe(false)
		})
	})

	test('no outcome file means no reconcile', async () => {
		await withWorkspace(async (workspace) => {
			const { status } = await runWithOutcome(workspace, () => Promise.resolve())
			expect(status.state).toBe('succeeded')
			expect(status.iamReconcile).toBeUndefined()
		})
	})

	test('a stale outcome file from an earlier attempt is cleared before the executor runs', async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(join(workspace, 'run-1.outcome.json'), JSON.stringify({ iamReconcile: { app: 'stale', schemaJson: '{}' } }))
			const { status } = await runWithOutcome(workspace, () => Promise.resolve())
			expect(status.state).toBe('succeeded')
			expect(status.iamReconcile).toBeUndefined()
		})
	})

	test('a malformed outcome file fails the run without quoting the file', async () => {
		for (
			const body of [
				'not json',
				'[]',
				JSON.stringify({ iamReconcile: { app: '', schemaJson: '{}' } }),
				JSON.stringify({ iamReconcile: { app: 'shop' } }),
			]
		) {
			await withWorkspace(async (workspace) => {
				const { status } = await runWithOutcome(workspace, (path) => writeFile(path, body))
				expect(status.state).toBe('failed')
				expect(status.error).toBe('runner outcome file is malformed')
				expect(status.iamReconcile).toBeUndefined()
			})
		}
	})

	test('an outcome file that is not a regular file fails the run', async () => {
		await withWorkspace(async (workspace) => {
			// A fifo is the real hazard; a directory is the portable stand-in for "not a regular file".
			const { status } = await runWithOutcome(workspace, (path) => mkdir(path))
			expect(status.state).toBe('failed')
			expect(status.error).toBe('runner outcome file is unreadable')
		})
	})

	test('the outcome file is deleted after a failed deploy too', async () => {
		await withWorkspace(async (workspace) => {
			const { status } = await runWithOutcome(
				workspace,
				(path) => writeFile(path, JSON.stringify({ iamReconcile: { app: 'shop', schemaJson: '{}' } })),
				1,
			)
			expect(status.state).toBe('failed')
			expect(status.exitCode).toBe(1)
			expect(status.iamReconcile).toBeUndefined()
			expect(await Bun.file(join(workspace, 'run-1.outcome.json')).exists()).toBe(false)
		})
	})

	test('the outcome file is deleted after a rejected deploy', async () => {
		await withWorkspace(async (workspace) => {
			const runner = new Runner(baseJob(), {
				workspace,
				spawn: async (spec, handlers) => {
					if (spec.command === 'git' && spec.args[0] === 'log') handlers.onStdout(`${COMMIT}\n`)
					if (spec.command === 'fabrika-cloudflare-executor') {
						await writeFile(join(workspace, 'run-1.outcome.json'), '{"iamReconcile":{"app":"shop","schemaJson":"{}"}}')
						throw new Error('pipe failed with tok-abcdef')
					}
					return { exitCode: 0 }
				},
			})
			const status = await runner.run()
			expect(status.error).toBe('runner execution failed unexpectedly')
			expect(status.iamReconcile).toBeUndefined()
			expect(await Bun.file(runner.outcomeFilePath).exists()).toBe(false)
		})
	})

	test('an oversized outcome file fails the run', async () => {
		await withWorkspace(async (workspace) => {
			const oversized = JSON.stringify({ iamReconcile: { app: 'shop', schemaJson: 'x'.repeat(1024 * 1024 + 64) } })
			const { status } = await runWithOutcome(workspace, (path) => writeFile(path, oversized))
			expect(status.state).toBe('failed')
			expect(status.error).toBe('runner outcome file exceeds the size limit')
			expect(await Bun.file(join(workspace, 'run-1.outcome.json')).exists()).toBe(false)
		})
	})
})

describe('approved access file', () => {
	/** Run one job in a real workspace, recording what the executor finds at the path its environment names. */
	const runSeeing = async (job: CloudflareRunnerJob): Promise<{ path: string | undefined; contents: string | undefined; workspace: string }> => {
		const workspace = await mkdtemp(join(tmpdir(), 'fabrika-runner-access-'))
		workspaces.add(workspace)
		let path: string | undefined
		let contents: string | undefined
		const spawn = async (spec: SpawnSpec, handlers: SpawnHandlers): Promise<SpawnResult> => {
			if (spec.command === 'git' && spec.args[0] === 'log') handlers.onStdout(`${COMMIT}\n`)
			if (spec.command === 'fabrika-cloudflare-executor') {
				path = spec.env?.[APPROVED_ACCESS_FILE_ENV]
				if (path !== undefined) contents = await readFile(path, 'utf8')
			}
			return { exitCode: 0 }
		}
		expect((await new Runner(job, { spawn, workspace }).run()).state).toBe('succeeded')
		return { path, contents, workspace }
	}

	test("the executor reads the job's approved access beside the checkout, under a name no job value redirects", async () => {
		const { path, contents, workspace } = await runSeeing(baseJob({ managedEnvironment: { [APPROVED_ACCESS_FILE_ENV]: '/tmp/forged.json' } }))
		expect(path).toBe(join(workspace, 'run-1.access.json'))
		expect(contents === undefined ? undefined : JSON.parse(contents)).toEqual({
			kind: 'contract',
			contract: notesArtifact,
			contractDigest: contractDigest(notesArtifact),
		})
		expect(await Bun.file(join(workspace, 'run-1.access.json')).exists()).toBe(false)
	})

	test('a dry run without approved access names no file, so the executor reads the checkout', async () => {
		const { approvedAccess: _none, ...job } = baseJob({ dryRun: true, secrets: { [APPROVED_ACCESS_FILE_ENV]: '/tmp/forged.json' } })
		expect((await runSeeing(job)).path).toBeUndefined()
	})
})
