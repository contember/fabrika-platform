import type { CloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
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
		expect(rec[0]?.spec.args).toEqual(['clone', '--depth', '1', '--branch', 'main', 'https://github.com/acme/app.git', '/workspace/run-1'])
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
		expect(recHeads[0]?.spec.args).toEqual(['clone', '--depth', '1', '--branch', 'main', 'https://github.com/acme/app.git', '/workspace/run-1'])

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

	test('credentials, secrets, vars and state namespace go into child env only', async () => {
		const rec: RecordedSpawn[] = []
		const spawn = makeSpawner(rec, () => ({ exitCode: 0 }))
		const job = baseJob({
			domain: 'stage.acme.com',
			stateNamespace: 'legacy-state',
			credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc-123456', CLOUDFLARE_API_TOKEN: 'tok-abcdef', PROPUSTKA_URL: 'https://iam.acme.com' },
			secrets: { SAMPLE_API_KEY: 'super-secret-value' },
			vars: { PUBLIC_ORIGIN: 'public-value' },
		})
		await new Runner(job, makeEnv(spawn)).run()

		const deploy = rec.find((r) => r.spec.command === 'fabrika-cloudflare-executor')?.spec
		expect(deploy?.env).toMatchObject({
			CLOUDFLARE_ACCOUNT_ID: 'acc-123456',
			CLOUDFLARE_API_TOKEN: 'tok-abcdef',
			PROPUSTKA_URL: 'https://iam.acme.com',
			VOZKA_DOMAIN: 'stage.acme.com',
			CLOUDFLARE_STATE_NAMESPACE: 'legacy-state',
			SAMPLE_API_KEY: 'super-secret-value',
			PUBLIC_ORIGIN: 'public-value',
		})
		// No secret/cred value ever appears on argv.
		const argvAll = rec.flatMap((r) => r.spec.args).join(' ')
		expect(argvAll).not.toContain('super-secret-value')
		expect(argvAll).not.toContain('tok-abcdef')
		expect(argvAll).not.toContain('public-value')
	})

	test('credential, secret and var values are redacted from log lines', async () => {
		const spawn = makeSpawner([], (spec, handlers) => {
			if (spec.command === 'fabrika-cloudflare-executor') {
				handlers.onStdout('deploying with token tok-abcdef, key super-secret-value and var public-value\n')
			}
			return { exitCode: 0 }
		})
		const job = baseJob({ secrets: { SAMPLE_API_KEY: 'super-secret-value' }, vars: { PUBLIC_ORIGIN: 'public-value' } })
		const runner = new Runner(job, makeEnv(spawn))
		await runner.run()

		const joined = runner.lines().map((l) => l.text).join('\n')
		expect(joined).not.toContain('tok-abcdef')
		expect(joined).not.toContain('super-secret-value')
		expect(joined).not.toContain('public-value')
		expect(joined).toContain('***')
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
