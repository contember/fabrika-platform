import type { RunLogLine } from '@fabrika/control-contract'
import {
	FABRIKA_RELEASE,
	OPERATIONS_ARTIFACT_HEADERS,
	OPERATIONS_RELEASE_RECONCILE_PATH,
	type OperationsReleaseReconcileRequest,
	parseOperationsReleasePayload,
	parseOperationsReleaseRequest,
} from '@fabrika/operations-contract/releases'
import { uuidv7 } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type CloudflareRunnerJob, cloudflareRunnerJobSchema, createCloudflareControlProvider } from '../../../provider-cloudflare/src/control'
import { type ArtifactFetch, Runner, type SpawnSpec } from '../../../runner-container/src/runner'
import { bunSpawner } from '../../../runner-container/src/spawn'
import { type ControlRepositories, type RunTrigger } from '../db'
import type { Env } from '../env'
import { cloudflareGitHubSource } from '../platform-cf'
import { executeDeploy } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { contractCommits, memoryCommits } from './helpers/commits'
import { createHarness, type Harness } from './helpers/harness'
import { fixtureProtect, makeFakeLock } from './helpers/lock'

const REPO_URL = 'https://github.com/acme/source-identity'
const REQUESTED_REF = 'refs/heads/main'
const SYNC_KEY = 'offline-operations-sync-key'.repeat(2)
const gitEnvironment: Record<string, string> = {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_SYSTEM: '/dev/null',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_COUNT: '0',
	GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_NAME: 'Source identity acceptance',
	GIT_AUTHOR_EMAIL: 'source-identity@example.test',
	GIT_COMMITTER_NAME: 'Source identity acceptance',
	GIT_COMMITTER_EMAIL: 'source-identity@example.test',
}

async function git(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	let stdout = ''
	let stderr = ''
	const result = await bunSpawner({ command: 'git', args, cwd, env: gitEnvironment }, {
		onStdout: (chunk) => {
			stdout += chunk
		},
		onStderr: (chunk) => {
			stderr += chunk
		},
	})
	return { ...result, stdout, stderr }
}

async function requireGit(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args)
	if (result.exitCode !== 0) throw new Error(`fixture Git failed: ${args[0]}: ${result.stderr}`)
	return result.stdout.trim()
}

function sourceMap(sentinel: string): string {
	return JSON.stringify({ version: 3, file: '/assets/app.js', sources: ['sentinel.txt'], sourcesContent: [`${sentinel}\n`], names: [], mappings: '' })
}

async function commitSource(cwd: string, sentinel: string): Promise<string> {
	await mkdir(join(cwd, 'worker', 'build'), { recursive: true })
	await writeFile(join(cwd, 'worker', 'sentinel.txt'), `${sentinel}\n`)
	await writeFile(join(cwd, 'worker', 'build', 'app.js.map'), sourceMap(sentinel))
	await writeFile(join(cwd, 'worker', 'package.json'), '{"private":true}')
	await writeFile(join(cwd, 'worker', 'fabrika.config.ts'), 'export default {}\n')
	await requireGit(cwd, ['add', '--', 'worker'])
	await requireGit(cwd, ['commit', '-m', sentinel, '--'])
	return requireGit(cwd, ['log', '-1', '--format=%H', '--'])
}

async function seedCloudflareRun(db: ControlRepositories, trigger: RunTrigger, recordedCommit?: string): Promise<string> {
	await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/source-identity', workerDir: 'worker', configPath: 'fabrika.config.ts' })
	await db.registry.upsertAppEnv({
		appId: 'app',
		env: 'prod',
		namespaceId: null,
		provider: 'cloudflare',
		providerTargetJson: JSON.stringify({ provider: 'cloudflare', version: 1, payload: { stateNamespace: 'app-state' } }),
		providerArtifactJson: JSON.stringify({ provider: 'cloudflare', version: 1, payload: { configPath: 'fabrika.config.ts' } }),
	})
	// Unprotected, so the first contract publishes without an approval (ADR-0050).
	await fixtureProtect(db.registry, makeFakeLock(db), { appId: 'app', env: 'prod' }, false)
	const runId = uuidv7()
	await db.runs.createRun({ id: runId, appId: 'app', env: 'prod', ref: REQUESTED_REF, trigger, commitSha: recordedCommit ?? null, actor: 'user:test' })
	return runId
}

/** Public sources never reach the vault, so the environment carries no key. */
function sourceEnvironment(harness: Harness): Env {
	return {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.reject(new Error('unexpected asset read')) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		COMMITS: memoryCommits(),
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'test',
	}
}

interface CheckoutObservation {
	command: string
	head: string
	detached: boolean
	sentinel: string
	map: string
	gitConfig: string
	env: Record<string, string>
	linesBeforeChild: RunLogLine[]
}

interface ProjectionObservation {
	payload: OperationsReleaseReconcileRequest
	persistedCommit: string | null
	persistedRef: string
}

interface UploadObservation {
	request: Request
	bytes: Uint8Array
}

async function joinedSourceWitness(trigger: RunTrigger, selectedObjectUnavailable = false): Promise<void> {
	const root = await mkdtemp('/tmp/opencode/cloudflare-source-identity-')
	const harness = createHarness()
	const { db, sqlite } = harness
	try {
		const origin = join(root, 'origin.git')
		const author = join(root, 'author')
		const workspace = join(root, 'runner')
		await mkdir(workspace)
		await requireGit(root, ['init', '--bare', '--', origin])
		await requireGit(root, ['init', '--initial-branch=main', '--', author])
		const commitA = await commitSource(author, 'A')
		const originUrl = pathToFileURL(origin).href
		await requireGit(author, ['push', '--', originUrl, 'HEAD:refs/heads/main'])
		expect(await requireGit(origin, ['show-ref', '--verify', '--hash', '--', REQUESTED_REF])).toBe(commitA)
		const runId = await seedCloudflareRun(db, trigger, trigger === 'manual' ? undefined : commitA)
		const beforeResolution = await db.runs.getRun(runId)
		expect(beforeResolution?.commit_sha).toBe(trigger === 'manual' ? null : commitA)

		const sourceRequests: string[] = []
		const source = cloudflareGitHubSource(sourceEnvironment(harness), {
			githubAppFetch: () => Promise.reject(new Error('public resolution must not create an App client')),
			metadataFetch: async (input) => {
				const url = new URL(input instanceof Request ? input.url : String(input))
				if (url.origin !== 'https://api.github.com') throw new Error('unexpected source API origin')
				sourceRequests.push(url.pathname)
				const prefix = '/repos/acme/source-identity/commits/'
				if (!url.pathname.startsWith(prefix)) throw new Error('unexpected source API path')
				const requested = decodeURIComponent(url.pathname.slice(prefix.length))
				if (requested === REQUESTED_REF) {
					return Response.json({ sha: await requireGit(origin, ['show-ref', '--verify', '--hash', '--', REQUESTED_REF]) })
				}
				if (!/^[0-9a-f]{40}$/.test(requested)) throw new Error('unexpected source ref')
				const objectType = await git(origin, ['cat-file', '-t', '--', requested])
				if (objectType.exitCode !== 0 || objectType.stdout.trim() !== 'commit') return Response.json({}, { status: 404 })
				const sha = await requireGit(origin, ['log', '-1', '--format=%H', requested, '--'])
				return Response.json({ sha })
			},
		})
		const projections: ProjectionObservation[] = []
		const uploads: UploadObservation[] = []
		const jobs: CloudflareRunnerJob[] = []
		const gitCommands: SpawnSpec[] = []
		const checkouts: CheckoutObservation[] = []
		const runnerLines: RunLogLine[] = []
		let phasesAtRunnerStart: string[] = []
		let persistedCommitAtRunnerStart: string | null | undefined
		let commitB: string | undefined
		const artifactFetch: ArtifactFetch = async (input, init) => {
			const request = new Request(input, init)
			uploads.push({ request, bytes: new Uint8Array(await request.arrayBuffer()) })
			return Response.json({ accepted: true })
		}
		const provider = createCloudflareControlProvider({
			accountId: 'offline-account',
			apiToken: 'offline-account-token',
			runnerKey: 'offline-runner-key',
			resolveSource: source.resolveSource,
			prepareClone: source.prepareClone,
			startRun: async (job) => {
				jobs.push(job)
				phasesAtRunnerStart = projections.map(({ payload }) => payload.phase)
				persistedCommitAtRunnerStart = (await db.runs.getRun(job.runId))?.commit_sha
				if (selectedObjectUnavailable) {
					const unrelatedAuthor = join(root, 'unrelated-author')
					await requireGit(root, ['init', '--initial-branch=main', '--', unrelatedAuthor])
					commitB = await commitSource(unrelatedAuthor, 'B')
					await rm(origin, { recursive: true, force: true })
					await requireGit(root, ['init', '--bare', '--', origin])
					await requireGit(unrelatedAuthor, ['push', '--', originUrl, 'HEAD:refs/heads/main'])
					expect((await git(origin, ['cat-file', '-e', '--', commitA])).exitCode).not.toBe(0)
				} else {
					commitB = await commitSource(author, 'B')
					await requireGit(author, ['push', '--', originUrl, 'HEAD:refs/heads/main'])
				}
				expect(await requireGit(origin, ['show-ref', '--verify', '--hash', '--', REQUESTED_REF])).toBe(commitB)
				const runner = new Runner(job, {
					workspace,
					fetch: artifactFetch,
					spawn: async (spec, handlers) => {
						if (spec.command === 'git') {
							gitCommands.push(spec)
							const env = { ...gitEnvironment, ...spec.env }
							const { GIT_CONFIG_COUNT = '0' } = env
							const configIndex = Number(GIT_CONFIG_COUNT)
							Object.assign(env, { GIT_CONFIG_COUNT: String(configIndex + 1) })
							env[`GIT_CONFIG_KEY_${configIndex}`] = `url.${originUrl}.insteadOf`
							env[`GIT_CONFIG_VALUE_${configIndex}`] = REPO_URL
							return bunSpawner({ ...spec, env }, handlers)
						}
						if (spec.command !== 'bun' && spec.command !== 'fabrika-cloudflare-executor') throw new Error('unexpected repository child')
						if (spec.command === 'bun' && spec.args.join(' ') !== 'install') throw new Error('unexpected Bun child')
						checkouts.push({
							command: spec.command,
							head: await requireGit(runner.checkoutDir, ['log', '-1', '--format=%H', '--']),
							detached: (await git(runner.checkoutDir, ['symbolic-ref', '--quiet', 'HEAD'])).exitCode === 1,
							sentinel: await readFile(join(spec.cwd, 'sentinel.txt'), 'utf8'),
							map: await readFile(join(spec.cwd, 'build', 'app.js.map'), 'utf8'),
							gitConfig: await readFile(join(runner.checkoutDir, '.git', 'config'), 'utf8'),
							env: spec.env ?? {},
							linesBeforeChild: [...runner.lines()],
						})
						if (spec.command === 'fabrika-cloudflare-executor') await writeFile(runner.outcomeFilePath, '{}')
						return { exitCode: 0 }
					},
				})
				runner.subscribe((line) => runnerLines.push(line))
				const status = await runner.run()
				expect(await Bun.file(runner.outcomeFilePath).exists()).toBe(false)
				if (status.state !== 'succeeded' && status.state !== 'failed') throw new Error('runner did not settle')
				return { state: status.state, exitCode: status.exitCode, artifactState: status.artifactState }
			},
			cancelRun: async () => {},
		})
		const result = await executeDeploy({
			repositories: db,
			provider,
			secrets: new VaultSecretResolver({}),
			lock: makeFakeLock(db),
			logs: { put: async () => {} },
			commits: contractCommits('app', 'worker'),
			operations: {
				repository: db.operationsReleases,
				syncKey: SYNC_KEY,
				artifactOrigin: 'https://artifacts.example.test',
				service: {
					fetch: async (request) => {
						if (new URL(request.url).pathname !== OPERATIONS_RELEASE_RECONCILE_PATH) throw new Error('unexpected projection path')
						const payload = parseOperationsReleaseRequest(await request.json())
						const run = await db.runs.getRun(payload.runId)
						if (run === null) throw new Error('projection has no persisted run')
						projections.push({ payload, persistedCommit: run.commit_sha, persistedRef: run.ref })
						return Response.json({ revision: payload.revision, outcome: 'applied' })
					},
				},
			},
		}, { runId })

		expect(result).toEqual({ runId, status: selectedObjectUnavailable ? 'failed' : 'succeeded' })
		expect(commitB).toMatch(/^[0-9a-f]{40}$/)
		expect(commitB).not.toBe(commitA)
		expect(sourceRequests).toEqual([
			`/repos/acme/source-identity/commits/${trigger === 'manual' ? encodeURIComponent(REQUESTED_REF) : commitA}`,
		])
		expect(phasesAtRunnerStart).toEqual(['started', 'provider_accepted'])
		expect(persistedCommitAtRunnerStart).toBe(commitA)
		expect(jobs).toHaveLength(1)
		const job = jobs[0]
		if (job === undefined || job.artifactUpload === undefined) throw new Error('missing runner artifact destination')
		expect(cloudflareRunnerJobSchema.safeParse(job).success).toBe(true)
		expect(job).toMatchObject({ runId, repoUrl: REPO_URL, ref: commitA, workerDir: 'worker', configPath: 'fabrika.config.ts' })
		expect(job.credentials).toEqual({ CLOUDFLARE_ACCOUNT_ID: 'offline-account', CLOUDFLARE_API_TOKEN: 'offline-account-token' })
		const storedRun = await db.runs.getRun(runId)
		expect(storedRun).toMatchObject({ trigger, ref: REQUESTED_REF, commit_sha: commitA, external_run_id: runId })
		expect(projections.map(({ payload }) => payload.phase)).toEqual(['started', 'provider_accepted', 'terminal'])
		const started = projections[0]?.payload
		if (started === undefined || started.release.kind !== 'available') throw new Error('missing started release')
		const releaseName = started.release.name
		expect(releaseName).toBe(`fabrika/app/prod/default/${commitA}`)
		expect(releaseName).not.toBe(commitA)
		for (const projection of projections) {
			expect(projection.persistedCommit).toBe(commitA)
			expect(projection.persistedRef).toBe(REQUESTED_REF)
			expect(projection.payload.release).toEqual({ kind: 'available', name: releaseName, commitSha: commitA })
			expect(projection.payload.coordinate).toEqual({ appId: 'app', environment: 'prod' })
			expect(projection.payload.uploadCredential?.verifier).toBe(new Bun.CryptoHasher('sha256').update(job.artifactUpload.bearer).digest('hex'))
		}
		expect(job.managedEnvironment?.[FABRIKA_RELEASE]).toBe(releaseName)
		expect(job.artifactUpload).toMatchObject({
			url: 'https://artifacts.example.test/api/artifacts/source-maps/',
			appId: 'app',
			environment: 'prod',
			serviceKey: 'default',
			release: releaseName,
			runId,
		})
		const storedProjection = await db.operationsReleases.get(runId)
		if (storedProjection === null) throw new Error('missing persisted terminal projection')
		const terminal = parseOperationsReleasePayload(JSON.parse(storedProjection.payload_json))
		expect(terminal).toMatchObject({ phase: 'terminal', outcome: result.status, release: started.release })

		if (selectedObjectUnavailable) {
			expect(gitCommands.map((spec) => spec.args[0])).toEqual(['init', 'fetch'])
			expect(checkouts).toEqual([])
			expect(uploads).toEqual([])
			expect(runnerLines.some((line) => line.text.startsWith('git fetch failed'))).toBe(true)
			expect(runnerLines.some((line) => line.text.includes('Installing dependencies') || line.text.includes('source maps'))).toBe(false)
			return
		}

		expect(gitCommands.map((spec) => spec.args[0])).toEqual(['init', 'fetch', 'switch', 'log'])
		expect(gitCommands[1]?.args).toEqual(['fetch', '--depth=1', '--no-tags', '--', REPO_URL, commitA])
		expect(checkouts.map((observation) => observation.command)).toEqual(['bun', 'fabrika-cloudflare-executor'])
		for (const checkout of checkouts) {
			expect(checkout).toMatchObject({ head: commitA, detached: true, sentinel: 'A\n', map: sourceMap('A') })
			expect(checkout.gitConfig).not.toContain(originUrl)
			expect(checkout.gitConfig).not.toContain('insteadOf')
			expect(Object.keys(checkout.env).some((key) => key.startsWith('GIT_'))).toBe(false)
			const witness = checkout.linesBeforeChild.findIndex((line) =>
				line.stream === 'meta' && line.text === `Git checkout verified: expected=${commitA} actual=${commitA}`
			)
			const install = checkout.linesBeforeChild.findIndex((line) => line.stream === 'meta' && line.text.startsWith('Installing dependencies'))
			expect(witness).toBeGreaterThanOrEqual(0)
			expect(install).toBeGreaterThan(witness)
		}
		expect(checkouts[1]?.env[FABRIKA_RELEASE]).toBe(releaseName)
		expect(uploads).toHaveLength(1)
		const upload = uploads[0]
		if (upload === undefined) throw new Error('missing source-map HTTP upload')
		expect(upload.bytes).toEqual(new TextEncoder().encode(sourceMap('A')))
		expect(upload.bytes).not.toEqual(new TextEncoder().encode(sourceMap('B')))
		expect(upload.request.url).toBe(job.artifactUpload.url)
		expect(upload.request.method).toBe('POST')
		expect(upload.request.headers.get('authorization')).toBe(`Bearer ${job.artifactUpload.bearer}`)
		expect(upload.request.headers.get(OPERATIONS_ARTIFACT_HEADERS.appId)).toBe(started.coordinate.appId)
		expect(upload.request.headers.get(OPERATIONS_ARTIFACT_HEADERS.environment)).toBe(started.coordinate.environment)
		expect(upload.request.headers.get(OPERATIONS_ARTIFACT_HEADERS.serviceKey)).toBe(job.artifactUpload.serviceKey)
		expect(upload.request.headers.get(OPERATIONS_ARTIFACT_HEADERS.release)).toBe(releaseName)
		expect(upload.request.headers.get(OPERATIONS_ARTIFACT_HEADERS.runId)).toBe(started.runId)
		expect(upload.request.headers.get(OPERATIONS_ARTIFACT_HEADERS.logicalPath)).toBe('assets/app.js')
		expect(upload.request.headers.get(OPERATIONS_ARTIFACT_HEADERS.digest)).toBe(new Bun.CryptoHasher('sha256').update(upload.bytes).digest('hex'))
		expect(terminal.artifactState).toBe('complete')
	} finally {
		sqlite.close()
		await rm(root, { recursive: true, force: true })
	}
}

describe('Cloudflare joined source identity', () => {
	const triggers: RunTrigger[] = ['webhook', 'poll', 'manual']
	for (const trigger of triggers) {
		test(`${trigger}: persisted A, moved branch B, detached HEAD A, runtime release A, and source-map upload A agree`, () =>
			joinedSourceWitness(trigger))
	}

	test('an object removed after source selection fails real Git fetch before Bun, executor, or artifact upload', () =>
		joinedSourceWitness('manual', true))
})
