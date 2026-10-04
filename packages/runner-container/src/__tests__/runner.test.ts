import type { CloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import { RUNNER_OUTCOME_FILE_ENV } from '@fabrika/runner-contract'
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSourceMaps, Runner, type RunnerEnv, type SpawnHandlers, type SpawnResult, type SpawnSpec } from '../runner'

// The Runner routes every child process through an injected `Spawner`, so these tests drive a full
// clone → install → fabrika-deploy pipeline with a fake — no git, no network, no real deploy.

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
	return script(spec, handlers)
}

const baseJob = (overrides: Partial<CloudflareRunnerJob> = {}): CloudflareRunnerJob => ({
	runId: 'run-1',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'main',
	env: 'stage',
	runnerKey: 'test-runner-key',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc-123456', CLOUDFLARE_API_TOKEN: 'tok-abcdef' },
	...overrides,
})

const makeEnv = (spawn: RunnerEnv['spawn']): RunnerEnv => ({ spawn, workspace: '/workspace' })

describe('Runner pipeline', () => {
	test('clone → install → deploy: faithful argv + cwd, success status with exit 0', async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, (spec, handlers) => {
			handlers.onStdout(`ran ${spec.command}\n`)
			return { exitCode: 0 }
		})
		const runner = new Runner(baseJob({ workerDir: 'worker', configPath: 'fabrika.config.ts', dryRun: true }), makeEnv(spawn))
		const status = await runner.run()

		expect(rec.map((r) => r.spec.command)).toEqual(['git', 'bun', 'fabrika-cloudflare-executor'])
		// clone into the run-keyed checkout dir
		expect(rec[0]?.spec.args).toEqual(['clone', '--depth', '1', '--branch', 'main', '--', 'https://github.com/acme/app.git', '/workspace/run-1'])
		// install + deploy run in workerDir
		expect(rec[1]?.spec).toMatchObject({ command: 'bun', args: ['install'], cwd: '/workspace/run-1/worker' })
		// deploy is faithful to M1's CLI contract
		expect(rec[2]?.spec).toMatchObject({
			command: 'fabrika-cloudflare-executor',
			args: ['deploy', '--env=stage', '--config=fabrika.config.ts', '--dry-run'],
			cwd: '/workspace/run-1/worker',
		})

		expect(status.state).toBe('succeeded')
		expect(status.exitCode).toBe(0)
		expect(typeof status.finishedAt).toBe('number')
	})

	test('strips refs/heads|tags/ from the ref for `git clone --branch` (a short name passes through)', async () => {
		const recHeads: RecordedSpawn[] = []
		await new Runner(baseJob({ ref: 'refs/heads/main', dryRun: true }), makeEnv(makeSpawner(recHeads, () => ({ exitCode: 0 })))).run()
		expect(recHeads[0]?.spec.args).toEqual(['clone', '--depth', '1', '--branch', 'main', '--', 'https://github.com/acme/app.git', '/workspace/run-1'])

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
		const runner = new Runner(baseJob({ repoUrl: `https://x-access-token:${token}@github.com/acme/app.git`, dryRun: true }), makeEnv(spawn))
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
		expect(texts).toEqual([overCap, 'tail'])
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
		const status = await new Runner(baseJob(), makeEnv(spawn)).run()

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

	test('real discovery requires a public logical path and never guesses from a nested basename', async () => {
		const root = await mkdtemp(join(tmpdir(), 'fabrika-source-maps-'))
		try {
			await mkdir(join(root, 'dist', 'assets'), { recursive: true })
			await writeFile(
				join(root, 'dist', 'assets', 'ambiguous.js.map'),
				JSON.stringify({ version: 3, file: 'ambiguous.js', sources: [], names: [], mappings: '' }),
			)
			await writeFile(
				join(root, 'dist', 'assets', 'rooted.js.map'),
				JSON.stringify({ version: 3, file: '/assets/rooted.js', sources: [], names: [], mappings: '' }),
			)
			const collection = await collectSourceMaps(root)
			expect(collection.incomplete).toBe(true)
			expect(collection.artifacts.map((artifact) => artifact.logicalPath)).toEqual(['assets/rooted.js'])
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

describe('executor outcome file', () => {
	/** A spawner that hands the executor's outcome file whatever `write` produces, in a real workspace. */
	const runWithOutcome = async (
		workspace: string,
		write: (path: string) => Promise<void>,
		deployExitCode = 0,
	): Promise<{ status: Awaited<ReturnType<Runner['run']>>; outcomePath: string | undefined }> => {
		let outcomePath: string | undefined
		const spawn = async (spec: SpawnSpec): Promise<SpawnResult> => {
			const path = spec.env?.[RUNNER_OUTCOME_FILE_ENV]
			if (spec.command !== 'fabrika-cloudflare-executor') return { exitCode: 0 }
			if (path !== undefined) {
				outcomePath = path
				await write(path)
			}
			return { exitCode: deployExitCode }
		}
		const status = await new Runner(baseJob(), { spawn, workspace }).run()
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
				spawn: async (spec) => {
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
