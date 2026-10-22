// The `dev` environment (ADR-0049): its registration, the record Control keeps, the `source` receiver the launcher
// waits on and reports to, and the MCP use cases, against SQLite always and Postgres when FABRIKA_TEST_POSTGRES_URL is
// set. GitHub is the recording fake; the SQL runs against the real schema.

import { type DevReport, type DevWaitAnswer, encodeDevReport, encodeDevWaitRequest, parseDevWaitAnswer } from '@fabrika/app/dev/wire'
import { hashPlatformKey } from '@fabrika/email/platform'
import type { SqlDatabase } from '@fabrika/platform'
import type { ControlProvider, ProviderDevEnvironmentInput } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import {
	bindDevUseCase,
	type DevUseCaseContext,
	followDevCommit,
	getDevStatusUseCase,
	resetDevUseCase,
	runChecksUseCase,
} from '../api/dev-environments'
import { ControlApiError } from '../api/domain'
import { putAppEnvUseCase } from '../api/registry/environments'
import { createWorkspaceUseCase, getDeploymentUseCase } from '../api/workspaces'
import { type ControlRepositories, createControlRepositories } from '../db'
import { devLauncherRefusal } from '../dev/deploy'
import { acceptDevReport, acceptDevWait, type DevReceiverDeps } from '../dev/receiver'
import { stopIdleDevServices } from '../dev/service'
import { DevSignals } from '../dev/signals'
import { createHarness } from './helpers/harness'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import {
	AUTHOR_ACTIONS,
	CONNECTION_ID,
	INSTALLATION_ID,
	oauthUser,
	registryContext,
	seedWorkspaceWorld,
	sha,
	type WorkspaceWorld,
	zeropsEnvelopes,
	zeropsProvider,
} from './helpers/workspaces'

if (!hasPostgres) console.warn(`dev-environments.test.ts Postgres half ${skipReason}`)

interface Backend {
	repositories: ControlRepositories
	db: SqlDatabase
	close(): Promise<void>
}

const backends: { name: string; skip: boolean; open(): Promise<Backend> }[] = [
	{
		name: 'sqlite',
		skip: false,
		open: () => {
			const harness = createHarness()
			return Promise.resolve({
				repositories: harness.repositories,
				db: harness.d1,
				close: () => {
					harness.sqlite.close()
					return Promise.resolve()
				},
			})
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async () => {
			const fixture = await createPostgres('vozka_dev')
			return { repositories: createControlRepositories(fixture.db), db: fixture.db, close: () => fixture.close() }
		},
	},
]

const SOURCE_KEY = 'px_dev-source-key-of-shop-dev'

/** A Zerops double that runs dev environments and records their stops and starts. */
function devProvider(): ControlProvider & { calls: string[] } {
	const calls: string[] = []
	const record = (kind: string) => (input: ProviderDevEnvironmentInput) => {
		calls.push(`${kind} ${input.environment.appId}/${input.environment.env}`)
		return Promise.resolve()
	}
	return { ...zeropsProvider, calls, devEnvironments: { stop: record('stop'), start: record('start') } }
}

interface DevWorld extends WorkspaceWorld {
	provider: ControlProvider & { calls: string[] }
	signals: DevSignals
	dev(auth?: ReturnType<typeof oauthUser>): DevUseCaseContext
	receiver(waitMs?: number): DevReceiverDeps
	workspaceId: string
}

for (const backend of backends) {
	describe.skipIf(backend.skip)(`dev environments (${backend.name})`, () => {
		let opened: Backend | null = null
		afterEach(async () => {
			await opened?.close()
			opened = null
		})

		async function world(): Promise<DevWorld> {
			opened = await backend.open()
			const { repositories, db } = opened
			const seeded = await seedWorkspaceWorld(repositories, db)
			const provider = devProvider()
			await putAppEnvUseCase(registryContext(repositories, provider), 'shop', 'dev', { ...zeropsEnvelopes(), kind: 'dev' })
			await repositories.platformTransportKeys.insert({
				app_id: 'shop',
				env: 'dev',
				receiver: 'source',
				key_id: 'key-1',
				key_hash: await hashPlatformKey(SOURCE_KEY),
				value_ref: 'vault:unused',
				expires_at: Math.floor(Date.now() / 1000) + 3600,
				created_at: Math.floor(Date.now() / 1000),
			})
			const signals = new DevSignals()
			const dev = (auth = oauthUser(AUTHOR_ACTIONS)): DevUseCaseContext => ({
				...seeded.context(auth),
				dev: {
					signals,
					start: async (row, signal) => {
						if (row.stopped_at === null) return
						await provider.devEnvironments?.start({ environment: { appId: row.app_id, env: row.env, ...zeropsEnvelopes() }, signal })
						await repositories.devEnvironments.markStarted(row.app_id, row.env)
					},
				},
			})
			const workspace = await createWorkspaceUseCase(dev(), { appId: 'shop', env: 'stage', title: 'Notes' })
			const receiver = (waitMs = 2_000): DevReceiverDeps => ({
				keys: repositories.platformTransportKeys,
				devEnvironments: repositories.devEnvironments,
				sourceTarget: () => Promise.resolve({ connectionId: 'conn-acme', installationId: 45, owner: 'acme', repository: 'shop' }),
				source: seeded.source,
				signals,
				now: () => Math.floor(Date.now() / 1000),
				waitMs,
			})
			return { ...seeded, provider, signals, dev, receiver, workspaceId: workspace.id }
		}

		async function succeedRun(db: SqlDatabase, runId: string): Promise<void> {
			await db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").bind(runId).run()
		}

		async function wait(w: DevWorld, body: { head: string; reset: number | null; checks: number | null; hold: boolean }, key = SOURCE_KEY) {
			const response = await acceptDevWait(w.receiver(), receiverRequest('wait', encodeDevWaitRequest(body), key))
			return { status: response.status, answer: response.ok ? answerOf(await response.json()) : null }
		}

		async function report(w: DevWorld, fields: Partial<DevReport> & { head: string; status: DevReport['status'] }) {
			const body = encodeDevReport({ target: null, message: null, log: [], reset: 0, checks: null, ...fields })
			return acceptDevReport(w.receiver(), receiverRequest('report', body, SOURCE_KEY))
		}

		test('a dev environment is registered only where it can run, and never protected', async () => {
			opened = await backend.open()
			const { repositories, db } = opened
			await seedWorkspaceWorld(repositories, db)
			await repositories.registry.createApp({
				id: 'blog',
				repoUrl: 'github.com/acme/blog',
				defaultBranch: 'main',
				githubConnectionId: CONNECTION_ID,
				githubInstallationId: INSTALLATION_ID,
			})
			const refused = (provider: ControlProvider, env: string, extra: object = {}, appId = 'shop') =>
				putAppEnvUseCase(registryContext(repositories, provider), appId, env, { ...zeropsEnvelopes(), kind: 'dev', ...extra })
					.then(() => null, (cause: unknown) => cause instanceof ControlApiError ? cause.message : 'unexpected')
			expect(await refused(zeropsProvider, 'dev')).toContain('runs no dev environment')
			expect(await refused(devProvider(), 'prod', {}, 'blog')).toContain('never production')
			expect(await refused(devProvider(), 'dev', {}, 'plain')).toContain('needs a GitHub connection')
			expect(await refused(devProvider(), 'dev', { authoring: true })).toContain('not an authoring target')
			expect(await refused(devProvider(), 'dev', { triggerRef: 'refs/heads/main' })).toContain('no trigger ref')
			expect(await refused(devProvider(), 'stage')).toContain('is standard')
			expect(await refused(devProvider(), 'dev')).toBeNull()
			expect(await refused(devProvider(), 'dev2')).toContain('already has the dev environment dev')
		})

		test('the first bind is a bootstrap run of the workspace head; a later bind of the same workspace is not', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			const first = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			expect(first.state).toBe('bootstrapping')
			expect(first.bootstrapRun).toEqual(expect.objectContaining({ env: 'dev', commitSha: sha('b') }))
			expect(w.queued).toHaveLength(1)
			// The bootstrap run is one of the workspace's runs, so get_deployment follows it.
			const runId = first.bootstrapRun?.id ?? ''
			const deployment = await getDeploymentUseCase(w.dev(), { runId, log: { lines: 10, failuresOnly: false } })
			expect(deployment.run.id).toBe(runId)

			await succeedRun(dbOf(opened), runId)
			const again = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			expect(again.bootstrapRun?.id).toBe(runId)
			expect(w.queued).toHaveLength(1)
			expect(again.state).toBe('pending')
		})

		test('a launcher waits for the next head and receives the changed files at it', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			const bound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await succeedRun(dbOf(opened), bound.bootstrapRun?.id ?? '')

			// The container holds the bootstrap head: nothing to sync, and it adopts the generations.
			expect(await wait(w, { head: sha('b'), reset: null, checks: null, hold: false })).toEqual({
				status: 200,
				answer: { sync: null, reset: 0, checks: 0 },
			})

			w.source.changedFiles = [
				{ path: 'src/notes/handler.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: null },
				{ path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, patch: null },
			]
			w.source.contents.set('src/notes/handler.ts', 'export const v = 2\n')
			w.source.contents.set('src/new.ts', 'export const n = 1\n')
			w.source.unreadable.set('src/old.ts', 'missing')
			const held = wait(w, { head: sha('b'), reset: 0, checks: 0, hold: true })
			await Bun.sleep(50)
			const applied = followDevCommit(w.dev(), { workspaceId: w.workspaceId, commitSha: sha('c') })
			expect((await held).answer).toEqual({
				sync: {
					from: sha('b'),
					to: sha('c'),
					files: [
						{ path: 'src/new.ts', content: 'export const n = 1\n' },
						{ path: 'src/notes/handler.ts', content: 'export const v = 2\n' },
						{ path: 'src/old.ts', content: null },
					],
				},
				reset: 0,
				checks: 0,
			})
			expect((await report(w, { head: sha('c'), status: 'serving', log: [{ n: 0, stream: 'stdout', text: 'listening' }] })).status).toBe(204)
			const dev = await applied
			expect(dev).toEqual({
				head: sha('c'),
				state: 'serving',
				summary: `Serving ${sha('c')}.`,
				url: null,
				log: [{ n: 0, stream: 'stdout', text: 'listening' }],
			})
		})

		test('Control refuses a head it cannot relay, and the launcher keeps what it serves', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			const bound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await succeedRun(dbOf(opened), bound.bootstrapRun?.id ?? '')
			w.source.changedFiles = [{ path: 'public/logo.png', previousPath: null, status: 'added', additions: 0, deletions: 0, patch: null }]
			w.source.unreadable.set('public/logo.png', 'binary')
			await w.repositories.devEnvironments.advanceTarget('shop', 'dev', w.workspaceId, sha('c'))
			expect((await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: false })).answer?.sync).toBeNull()
			const status = await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 10, failuresOnly: false } })
			expect(status.state).toBe('needs_bootstrap')
			expect(status.summary).toContain('public/logo.png is not UTF-8 text')
			// The refused head is not offered again, so a held wait does not spin.
			expect((await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: false })).answer?.sync).toBeNull()

			// bind_dev again bootstraps the refused head; the new container's report clears the refusal.
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('c'))
			const rebound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			expect(rebound.bootstrapRun?.commitSha).toBe(sha('c'))
			expect(w.queued).toHaveLength(2)
			await succeedRun(dbOf(opened), rebound.bootstrapRun?.id ?? '')
			await report(w, { head: sha('c'), status: 'serving' })
			const serving = await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 0, failuresOnly: false } })
			expect(serving.state).toBe('serving')
			expect((await w.repositories.devEnvironments.get('shop', 'dev'))?.refused_sha).toBeNull()
		})

		test("a launcher's refusal is recorded, and get_dev_status reads its log window", async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await w.repositories.devEnvironments.advanceTarget('shop', 'dev', w.workspaceId, sha('c'))
			const log = [0, 1, 2].map((n) => ({ n, stream: n === 1 ? 'stderr' as const : 'stdout' as const, text: `line ${n}` }))
			await report(w, { head: sha('b'), status: 'needs_bootstrap', target: sha('c'), message: 'bun.lock changed', log })
			const row = await w.repositories.devEnvironments.get('shop', 'dev')
			expect(row?.refused_sha).toBe(sha('c'))
			const status = await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 10, failuresOnly: true } })
			expect(status.log).toEqual({ lines: [{ n: 1, stream: 'stderr', text: 'line 1' }], from: 0, to: 1, total: 1 })
		})

		test('run_checks and reset_dev advance their generations and wait for the report', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			const bound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await succeedRun(dbOf(opened), bound.bootstrapRun?.id ?? '')
			await report(w, { head: sha('b'), status: 'serving' })

			const checking = runChecksUseCase(w.dev(), { workspaceId: w.workspaceId })
			const asked = (await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: true })).answer
			expect(asked).toEqual({ sync: null, reset: 0, checks: 1 })
			const results = [{ name: 'tsc', ok: true, exitCode: 0, output: [] }]
			await report(w, { head: sha('b'), status: 'serving', checks: { request: 1, results } })
			expect((await checking).checks).toEqual({ request: 1, results })

			const resetting = resetDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			expect((await wait(w, { head: sha('b'), reset: 0, checks: 1, hold: true })).answer).toEqual({ sync: null, reset: 1, checks: 1 })
			await report(w, { head: sha('b'), status: 'serving', reset: 1 })
			expect((await resetting).state).toBe('serving')
		})

		test('switching the bound workspace resets the schema; another workspace cannot run checks', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			const bound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await succeedRun(dbOf(opened), bound.bootstrapRun?.id ?? '')
			const other = await createWorkspaceUseCase(w.dev(), { appId: 'shop', env: 'stage', title: 'Other' })
			await expect(runChecksUseCase(w.dev(), { workspaceId: other.id })).rejects.toThrow('call bind_dev first')
			w.source.branches.set(`fabrika/${other.id}`, sha('d'))
			const switched = await bindDevUseCase(w.dev(), { workspaceId: other.id })
			expect(switched.workspaceId).toBe(other.id)
			expect(w.queued).toHaveLength(1)
			expect((await w.repositories.devEnvironments.get('shop', 'dev'))?.reset_generation).toBe(1)
			// A commit to the workspace that is no longer bound follows nothing.
			expect(await followDevCommit(w.dev(), { workspaceId: w.workspaceId, commitSha: sha('e') })).toBeNull()
		})

		test('the receiver answers only a source key', async () => {
			const w = await world()
			await w.repositories.platformTransportKeys.insert({
				app_id: 'shop',
				env: 'dev',
				receiver: 'mail',
				key_id: 'key-2',
				key_hash: await hashPlatformKey('px_mail-key'),
				value_ref: 'vault:unused',
				expires_at: Math.floor(Date.now() / 1000) + 3600,
				created_at: Math.floor(Date.now() / 1000),
			})
			expect((await wait(w, { head: sha('b'), reset: null, checks: null, hold: false }, 'px_mail-key')).status).toBe(401)
			expect((await wait(w, { head: sha('b'), reset: null, checks: null, hold: false }, 'px_unknown')).status).toBe(401)
			const malformed = await acceptDevWait(w.receiver(), receiverRequest('wait', '{"head":"x"}', SOURCE_KEY))
			expect(malformed.status).toBe(400)
		})

		test('maintenance stops an idle dev service, and the next commit starts it', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			const bound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await succeedRun(dbOf(opened), bound.bootstrapRun?.id ?? '')
			const now = Math.floor(Date.now() / 1000)
			const deps = { repositories: w.repositories, provider: w.provider }
			expect(await stopIdleDevServices(deps, now)).toEqual({ stopped: 0, failed: 0 })
			expect(await stopIdleDevServices(deps, now + 31 * 60)).toEqual({ stopped: 1, failed: 0 })
			expect(w.provider.calls).toEqual(['stop shop/dev'])
			expect((await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 0, failuresOnly: false } })).state).toBe('stopped')

			const following = followDevCommit(w.dev(), { workspaceId: w.workspaceId, commitSha: sha('c') })
			await Bun.sleep(50)
			await report(w, { head: sha('c'), status: 'serving' })
			expect((await following)?.state).toBe('serving')
			expect(w.provider.calls).toEqual(['stop shop/dev', 'start shop/dev'])
		})
	})
}

describe('the dev launcher release', () => {
	test('is 0.9.0 or newer; a local pack of it counts as the release, and an unrecorded release as older', () => {
		expect(devLauncherRefusal('0.9.0')).toBeNull()
		expect(devLauncherRefusal('0.9.0-local.gabc1234')).toBeNull()
		expect(devLauncherRefusal('1.2.0')).toBeNull()
		expect(devLauncherRefusal('0.8.1')).toContain('the application pins 0.8.1')
		expect(devLauncherRefusal(undefined)).toContain('the application pins an older release')
	})
})

function dbOf(backend: Backend | null): SqlDatabase {
	if (backend === null) throw new Error('no backend is open')
	return backend.db
}

function receiverRequest(kind: 'wait' | 'report', body: string, key: string): Request {
	return new Request(`https://control.example/platform/source/${kind}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body,
	})
}

function answerOf(json: unknown): DevWaitAnswer {
	const parsed = parseDevWaitAnswer(json)
	if (!parsed.ok) throw new Error('the receiver answered a body the launcher does not read')
	return parsed.value
}
