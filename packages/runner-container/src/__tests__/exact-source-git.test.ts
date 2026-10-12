import type { CloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import { cloudflareRunnerJobSchema } from '@fabrika/provider-cloudflare/runner'
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { contractDigest } from '../../../auth-core/src/endpoint-digest'
import { Runner, type RunnerEnv, type SpawnSpec } from '../runner'
import { bunSpawner } from '../spawn'

const CLEAN_URL = 'https://github.com/acme/exact-source.git'
const TOKEN = 'private-git/%:@+value'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
const HEADER = `Authorization: Basic ${BASIC}`
const GIT_ENV = {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_NAME: 'Exact source test',
	GIT_AUTHOR_EMAIL: 'source@example.test',
	GIT_COMMITTER_NAME: 'Exact source test',
	GIT_COMMITTER_EMAIL: 'source@example.test',
}

interface GitResult {
	exitCode: number
	stdout: string
}

const gitResult = async (cwd: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> => {
	let stdout = ''
	const result = await bunSpawner({ command: 'git', args, cwd, env: { ...GIT_ENV, ...env } }, {
		onStdout: (chunk) => {
			stdout += chunk
		},
		onStderr: () => {},
	})
	return { ...result, stdout }
}

const git = async (cwd: string, args: string[]): Promise<string> => {
	const result = await gitResult(cwd, args)
	if (result.exitCode !== 0) throw new Error(`fixture Git command failed: ${args[0]}`)
	return result.stdout.trim()
}

interface OriginFixture {
	root: string
	author: string
	origin: string
	workspace: string
	commitA: string
	commitB: string
}

const sourceMap = (sentinel: string): string =>
	JSON.stringify({
		version: 3,
		file: '/assets/app.js',
		sources: ['app.ts'],
		sourcesContent: [sentinel],
		names: [],
		mappings: '',
	})

const commit = async (author: string, sentinel: string): Promise<string> => {
	await writeFile(join(author, 'sentinel.txt'), sentinel)
	await writeFile(join(author, 'app.js.map'), sourceMap(sentinel))
	await writeFile(join(author, 'fabrika.config.ts'), `export default { source: '${sentinel}' }\n`)
	await git(author, ['add', '--', 'sentinel.txt', 'app.js.map', 'fabrika.config.ts'])
	await git(author, ['commit', '--no-gpg-sign', '-m', sentinel, '--'])
	return git(author, ['log', '-1', '--format=%H', '--'])
}

const withOrigin = async (body: (fixture: OriginFixture) => Promise<void>): Promise<void> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-exact-source-'))
	try {
		const author = join(root, 'author')
		const origin = join(root, 'origin.git')
		const workspace = join(root, 'workspace')
		await mkdir(workspace)
		await git(root, ['init', '--bare', '--initial-branch=main', '--', origin])
		await git(root, ['init', '--initial-branch=main', '--', author])
		const commitA = await commit(author, 'source-A')
		await git(author, ['push', '--', origin, 'main'])
		const commitB = await commit(author, 'source-B')
		await git(author, ['push', '--', origin, 'main'])
		expect(await git(origin, ['show-ref', '--verify', '--hash', '--', 'refs/heads/main'])).toBe(commitB)
		expect(commitB).not.toBe(commitA)
		await body({ root, author, origin, workspace, commitA, commitB })
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

const makeJob = (ref: string, dryRun = false): CloudflareRunnerJob => ({
	runId: '0198d922-06f6-7000-8000-000000000001',
	repoUrl: `https://x-access-token:${encodeURIComponent(TOKEN)}@github.com/acme/exact-source.git`,
	ref,
	env: 'stage',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'test-cloudflare-token' },
	approvedAccess: { kind: 'contract', contract: notesArtifact, contractDigest: contractDigest(notesArtifact) },
	dryRun,
})

// Rewrite only the test Git child's transport; production still receives and validates an HTTPS job.
const localGitSpec = (spec: SpawnSpec, origin: string): SpawnSpec => {
	const env: Record<string, string> = { ...GIT_ENV, ...spec.env }
	const { GIT_CONFIG_COUNT: configCount = '0' } = env
	const count = Number(configCount)
	return {
		...spec,
		env: {
			...env,
			GIT_CONFIG_COUNT: String(count + 2),
			[`GIT_CONFIG_KEY_${count}`]: `url.${pathToFileURL(origin).href}.insteadOf`,
			[`GIT_CONFIG_VALUE_${count}`]: CLEAN_URL,
			[`GIT_CONFIG_KEY_${count + 1}`]: 'protocol.file.allow',
			[`GIT_CONFIG_VALUE_${count + 1}`]: 'always',
		},
	}
}

const assertNoGitAuthority = (spec: SpawnSpec): void => {
	expect(Object.keys(spec.env ?? {}).some((key) => key.startsWith('GIT_'))).toBe(false)
	const child = JSON.stringify(spec)
	for (const value of [TOKEN, encodeURIComponent(TOKEN), BASIC, HEADER]) expect(child).not.toContain(value)
}

const runCheckout = async (fixture: OriginFixture, dryRun = false, ref = fixture.commitA): Promise<void> => {
	const job: CloudflareRunnerJob = {
		...makeJob(ref, dryRun),
		...(dryRun
			? {
				artifactUpload: {
					url: 'https://operations.test/api/artifacts/source-maps/',
					bearer: 'synthetic-artifact-authorization',
					appId: 'app',
					environment: 'stage',
					serviceKey: 'default',
					release: 'unavailable-preview-release',
					runId: '0198d922-06f6-7000-8000-000000000001',
				},
			}
			: {}),
	}
	expect(cloudflareRunnerJobSchema.safeParse(job).success).toBe(true)
	const specs: SpawnSpec[] = []
	const observed: { command: string; head: string; sentinel: string; map: string; detached: boolean; config: string; witnessed: boolean }[] = []
	const originalEnv = { ...process.env }
	let uploads = 0
	const expected = ref === 'main' ? fixture.commitB : fixture.commitA
	const witness = `Git checkout verified: expected=${expected} actual=${expected}`
	const runner = new Runner(job, {
		workspace: fixture.workspace,
		fetch: async () => {
			uploads++
			return new Response(null, { status: 201 })
		},
		spawn: async (spec, handlers) => {
			specs.push(spec)
			if (spec.command === 'git') return bunSpawner(localGitSpec(spec, fixture.origin), handlers)
			if (spec.command !== 'bun' && spec.command !== 'fabrika-cloudflare-executor') throw new Error('unexpected repository command')
			assertNoGitAuthority(spec)
			observed.push({
				command: spec.command,
				head: await git(spec.cwd, ['log', '-1', '--format=%H', '--']),
				sentinel: await readFile(join(spec.cwd, 'sentinel.txt'), 'utf8'),
				map: await readFile(join(spec.cwd, 'app.js.map'), 'utf8'),
				detached: (await gitResult(spec.cwd, ['symbolic-ref', '--quiet', '--', 'HEAD'])).exitCode === 1,
				config: await readFile(join(spec.cwd, '.git', 'config'), 'utf8'),
				witnessed: runner.lines().some((line) => line.text === witness),
			})
			return { exitCode: 0 }
		},
	})
	const witnessStates: string[] = []
	runner.subscribe((line) => {
		if (line.text === witness) witnessStates.push(runner.status().state)
	})
	const status = await runner.run()
	expect(status.state).toBe('succeeded')
	expect(uploads).toBe(0)
	expect(status.artifactState).toBe(dryRun ? 'not_applicable' : undefined)
	expect(observed.map((value) => value.command)).toEqual(['bun', 'fabrika-cloudflare-executor'])
	for (const value of observed) {
		expect(value.head).toBe(expected)
		expect(value.sentinel).toBe(ref === 'main' ? 'source-B' : 'source-A')
		expect(value.map).toBe(sourceMap(value.sentinel))
		expect(value.detached).toBe(ref !== 'main')
		expect(value.witnessed).toBe(ref !== 'main')
		expect(value.config).not.toContain('extraHeader')
		for (const sensitive of [TOKEN, encodeURIComponent(TOKEN), BASIC, HEADER]) expect(value.config).not.toContain(sensitive)
	}
	expect(witnessStates).toEqual(ref === 'main' ? [] : ['cloning'])
	const gitSpecs = specs.filter((spec) => spec.command === 'git')
	expect(gitSpecs.map((spec) => spec.args[0])).toEqual(ref === 'main' ? ['clone'] : ['init', 'fetch', 'switch', 'log'])
	for (const spec of gitSpecs) {
		expect(spec.args).toContain('--')
		expect(spec.env).toEqual({
			GIT_TERMINAL_PROMPT: '0',
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: `http.${CLEAN_URL}.extraHeader`,
			GIT_CONFIG_VALUE_0: HEADER,
		})
		for (const value of [TOKEN, encodeURIComponent(TOKEN), BASIC, HEADER]) expect(spec.args.join(' ')).not.toContain(value)
	}
	const firstGit = gitSpecs[0]
	if (firstGit === undefined) throw new Error('runner did not execute Git')
	expect((await gitResult(fixture.root, ['config', '--get-urlmatch', '--', 'http.extraHeader', `${CLEAN_URL}/info/refs`], firstGit.env)).stdout.trim())
		.toBe(HEADER)
	expect(
		(await gitResult(fixture.root, ['config', '--get-urlmatch', '--', 'http.extraHeader', `${CLEAN_URL}-other/info/refs`], firstGit.env)).exitCode,
	).toBe(1)
	const diagnostics = JSON.stringify({ status, lines: runner.lines() })
	for (const value of [TOKEN, encodeURIComponent(TOKEN), BASIC, HEADER]) expect(diagnostics).not.toContain(value)
	expect(process.env).toEqual(originalEnv)
}

describe('real exact-source Git checkout', () => {
	test('a repeated completed job refuses the checkout before Git or Bun and preserves tracked and untracked edits', async () => {
		await withOrigin(async (fixture) => {
			const job: CloudflareRunnerJob = { ...makeJob(fixture.commitA), configPath: 'fabrika.config.ts' }
			expect(cloudflareRunnerJobSchema.safeParse(job).success).toBe(true)
			const commands: SpawnSpec[] = []
			const env: RunnerEnv = {
				workspace: fixture.workspace,
				spawn: async (spec, handlers) => {
					commands.push(spec)
					if (spec.command === 'git') return bunSpawner(localGitSpec(spec, fixture.origin), handlers)
					if (spec.command === 'fabrika-cloudflare-executor') {
						expect(await git(spec.cwd, ['log', '-1', '--format=%H', '--'])).toBe(fixture.commitA)
						expect(await readFile(join(spec.cwd, 'fabrika.config.ts'), 'utf8')).toBe("export default { source: 'source-A' }\n")
						await writeFile(join(spec.cwd, 'fabrika.config.ts'), 'modified tracked config')
						await writeFile(join(spec.cwd, 'untracked.txt'), 'left by the first executor')
					}
					return { exitCode: 0 }
				},
			}
			const first = new Runner(job, env)
			expect((await first.run()).state).toBe('succeeded')
			expect(await git(first.checkoutDir, ['log', '-1', '--format=%H', '--'])).toBe(fixture.commitA)
			expect(await readFile(join(first.checkoutDir, 'fabrika.config.ts'), 'utf8')).toBe('modified tracked config')
			expect(await readFile(join(first.checkoutDir, 'untracked.txt'), 'utf8')).toBe('left by the first executor')
			const config = await readFile(join(first.checkoutDir, '.git', 'config'), 'utf8')
			commands.length = 0
			const second = new Runner(job, env)
			const status = await second.run()
			expect(status.state).toBe('failed')
			expect(status.error).toBe('checkout directory already exists')
			expect(second.isDone()).toBe(true)
			expect(commands).toEqual([])
			expect(second.lines().some((line) => line.text.startsWith('Git checkout verified:') || line.text.startsWith('Installing dependencies'))).toBe(
				false,
			)
			expect(await git(second.checkoutDir, ['log', '-1', '--format=%H', '--'])).toBe(fixture.commitA)
			expect(await readFile(join(second.checkoutDir, 'fabrika.config.ts'), 'utf8')).toBe('modified tracked config')
			expect(await readFile(join(second.checkoutDir, 'untracked.txt'), 'utf8')).toBe('left by the first executor')
			expect(await readFile(join(second.checkoutDir, '.git', 'config'), 'utf8')).toBe(config)
		})
	})

	test('origin main moves from A to B, but every production Git command selects detached A before Bun', async () => {
		await withOrigin((fixture) => runCheckout(fixture))
	})

	test('a branch literally named A points to B: old branch clone selects B, exact Runner still verifies A', async () => {
		await withOrigin(async (fixture) => {
			await git(fixture.author, ['branch', '--', fixture.commitA, fixture.commitB])
			await git(fixture.author, ['push', '--', fixture.origin, fixture.commitA])
			const oldCheckout = join(fixture.root, 'old-branch-checkout')
			await git(fixture.root, ['clone', '--depth', '1', '--branch', fixture.commitA, '--', pathToFileURL(fixture.origin).href, oldCheckout])
			expect(await git(oldCheckout, ['log', '-1', '--format=%H', '--'])).toBe(fixture.commitB)
			expect(await readFile(join(oldCheckout, 'sentinel.txt'), 'utf8')).toBe('source-B')
			await runCheckout(fixture)
		})
	})

	test('a full-SHA dry preview also fetches, detaches and verifies A after main moves to B', async () => {
		await withOrigin((fixture) => runCheckout(fixture, true))
	})

	test('an uppercase full-SHA dry preview uses exact checkout rather than a branch clone', async () => {
		await withOrigin((fixture) => runCheckout(fixture, true, fixture.commitA.toUpperCase()))
	})

	test('a mutable dry preview clones the current B branch with a credential-free remote', async () => {
		await withOrigin((fixture) => runCheckout(fixture, true, 'main'))
	})

	test('an object absent from the real origin fails fetch without installation, executor or artifacts', async () => {
		await withOrigin(async (fixture) => {
			const missing = await commit(fixture.author, 'unpublished-source-C')
			const job: CloudflareRunnerJob = {
				...makeJob(missing),
				artifactUpload: {
					url: 'https://operations.test/api/artifacts/source-maps/',
					bearer: 'synthetic-artifact-authorization',
					appId: 'app',
					environment: 'stage',
					serviceKey: 'default',
					release: `fabrika/app/stage/default/${missing}`,
					runId: '0198d922-06f6-7000-8000-000000000001',
				},
			}
			expect(cloudflareRunnerJobSchema.safeParse(job).success).toBe(true)
			let repositoryWork = false
			let artifacts = false
			const gitSpecs: SpawnSpec[] = []
			const runner = new Runner(job, {
				workspace: fixture.workspace,
				spawn: async (spec, handlers) => {
					if (spec.command !== 'git') {
						repositoryWork = true
						throw new Error('missing source must not execute repository commands')
					}
					gitSpecs.push(spec)
					return bunSpawner(localGitSpec(spec, fixture.origin), handlers)
				},
				collectSourceMaps: async () => {
					artifacts = true
					return { artifacts: [], incomplete: false }
				},
				fetch: async () => {
					artifacts = true
					return new Response(null, { status: 201 })
				},
			})
			const status = await runner.run()
			expect(status.state).toBe('failed')
			expect(status.error).toBe('git fetch failed (exit 128)')
			expect(gitSpecs.map((spec) => spec.args[0])).toEqual(['init', 'fetch'])
			expect(repositoryWork).toBe(false)
			expect(artifacts).toBe(false)
			expect(runner.lines().some((line) => line.text.startsWith('Git checkout verified:'))).toBe(false)
			expect(await git(fixture.origin, ['show-ref', '--verify', '--hash', '--', 'refs/heads/main'])).toBe(fixture.commitB)
		})
	})
})
