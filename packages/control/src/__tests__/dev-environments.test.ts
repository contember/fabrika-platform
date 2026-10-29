// The `dev` environment (ADR-0049): its registration, the record Control keeps of a workspace's sandbox, the `source`
// receiver the launcher waits on and reports to, and the MCP use cases, against SQLite always and Postgres when
// FABRIKA_TEST_POSTGRES_URL is set. GitHub and the sandbox host are recording fakes; the SQL runs against the real schema.

import { type DevLogLine, type DevReport, type DevWaitAnswer, encodeDevReport, encodeDevWaitRequest, parseDevWaitAnswer } from '@fabrika/app/dev/wire'
import { hashPlatformKey } from '@fabrika/email/platform'
import type { SqlDatabase } from '@fabrika/platform'
import type { ControlProvider, ProviderDevSandboxes, ProviderDevSandboxInput } from '@fabrika/provider-contract'
import { afterEach, describe, expect, test } from 'bun:test'
import {
	bindDevUseCase,
	type DevUseCaseContext,
	followDevCommit,
	getDevStatusUseCase,
	listDevTargetsUseCase,
	resetDevUseCase,
	runChecksUseCase,
} from '../api/dev-environments'
import { ControlApiError } from '../api/domain'
import { putAppEnvUseCase } from '../api/registry/environments'
import { createWorkspaceUseCase, getDeploymentUseCase } from '../api/workspaces'
import { type ControlRepositories, createControlRepositories } from '../db'
import { devLauncherRefusal } from '../dev/deploy'
import { acceptDevReport, acceptDevWait, type DevReceiverDeps, LAUNCHER_UNREADABLE } from '../dev/receiver'
import { DEV_IDLE_STOP_SECONDS, type DevSandboxDeps, maintainDevSandboxes } from '../dev/service'
import { DevSignals } from '../dev/signals'
import { DEV_SYNC_MAX_FILES } from '../dev/sync'
import { VaultPlatformTransport } from '../platform-transport'
import { Vault } from '../vault'
import { createHarness } from './helpers/harness'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { testVaultKey } from './helpers/vault'
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

const DOMAIN = 'dev.shop.test'
const NAMESPACE = 'apps-dev'
const ENVELOPE = JSON.stringify({ provider: 'zerops', version: 1, payload: {} })

/** A sandbox host double that records its calls; every sandbox it was asked for exists. */
function sandboxHost(): ProviderDevSandboxes & { calls: string[] } {
	const calls: string[] = []
	const record = (kind: string) => (input: ProviderDevSandboxInput) => {
		calls.push(`${kind} ${input.sandbox.sandboxId}`)
		return Promise.resolve()
	}
	return {
		calls,
		admit: () => {},
		ensure: (input) => {
			calls.push(`ensure ${input.workspaceId}`)
			const sandboxId = `sbx-${input.workspaceId}`
			return Promise.resolve({ sandboxId, baseDigest: 'sha256:base', upstreamHost: `3000-${sandboxId}.box.test` })
		},
		park: record('park'),
		wake: record('wake'),
		remove: () => Promise.resolve(),
	}
}

/** A Zerops double that runs dev environments as workspace sandboxes. */
function devProvider(): ControlProvider {
	return { ...zeropsProvider, devSandboxes: sandboxHost() }
}

interface DevWorld extends WorkspaceWorld {
	host: ProviderDevSandboxes & { calls: string[] }
	deps: DevSandboxDeps
	signals: DevSignals
	dev(auth?: ReturnType<typeof oauthUser>): DevUseCaseContext
	receiver(waitMs?: number): DevReceiverDeps
	workspaceId: string
	/** The workspace's own source key, as its bootstrap hands it to the launcher. */
	key: string
	/** The use cases' clock: real time moved by `skew` seconds. */
	clock: { skew: number; readonly now: number }
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
			const vault = await Vault.create(db, testVaultKey())
			await repositories.registry.createDeploymentNamespaceWithResourceClaims({
				id: NAMESPACE,
				env: 'dev',
				provider: 'zerops',
				exclusiveAppId: null,
				providerTargetJson: ENVELOPE,
				state: 'ready',
			}, [])
			await repositories.registry.upsertAppEnv({
				appId: 'shop',
				env: 'dev',
				kind: 'dev',
				domain: DOMAIN,
				namespaceId: NAMESPACE,
				provider: 'zerops',
				providerTargetJson: ENVELOPE,
				providerArtifactJson: ENVELOPE,
			})
			const host = sandboxHost()
			const transport = new VaultPlatformTransport(repositories.platformTransportKeys, () => Promise.resolve(vault))
			const deps: DevSandboxDeps = {
				repositories,
				provider: { devSandboxes: host },
				vault: () => Promise.resolve(vault),
				platformTransport: transport,
				namespaceProxyChanged: () => Promise.resolve(),
			}
			const signals = new DevSignals()
			const clock = {
				skew: 0,
				get now() {
					return Math.floor(Date.now() / 1000) + this.skew
				},
			}
			const dev = (auth = oauthUser(AUTHOR_ACTIONS)): DevUseCaseContext => ({
				...seeded.context(auth),
				dev: { signals, sandboxes: deps, now: () => clock.now },
			})
			const workspace = await createWorkspaceUseCase(dev(), { appId: 'shop', env: 'stage', title: 'Notes' })
			const receiver = (waitMs = 2_000): DevReceiverDeps => ({
				keys: repositories.platformTransportKeys,
				devSandboxes: repositories.devSandboxes,
				sourceTarget: () => Promise.resolve({ connectionId: 'conn-acme', installationId: 45, owner: 'acme', repository: 'shop' }),
				source: seeded.source,
				signals,
				now: () => Math.floor(Date.now() / 1000),
				waitMs,
				run: (runId) => repositories.runs.getRun(runId),
			})
			// The key a bootstrap would hand the launcher; Control issues one only while the workspace has a sandbox row.
			await repositories.devSandboxes.insertCreating({ workspaceId: workspace.id, appId: 'shop', env: 'dev', now: clock.now, attempt: 'bind' })
			const key = await transport.issue('shop', 'dev', 'source', { workspaceId: workspace.id })
			await repositories.devSandboxes.delete(workspace.id)
			return { ...seeded, host, deps, signals, dev, receiver, workspaceId: workspace.id, key, clock }
		}

		async function succeedRun(db: SqlDatabase, runId: string): Promise<void> {
			await db.prepare("UPDATE runs SET status = 'succeeded', finished_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), runId).run()
		}

		/** A launcher's wait; its container is the bootstrap of `sha('b')` unless `bootstrap` says otherwise. */
		async function wait(
			w: DevWorld,
			body: { head: string; reset: number | null; checks: number | null; hold: boolean; bootstrap?: string },
			key = w.key,
		) {
			const response = await acceptDevWait(w.receiver(), receiverRequest('wait', encodeDevWaitRequest({ bootstrap: sha('b'), ...body }), key))
			return { status: response.status, answer: response.ok ? answerOf(await response.json()) : null }
		}

		async function report(w: DevWorld, fields: Partial<DevReport> & { head: string; status: DevReport['status'] }) {
			const body = encodeDevReport({ bootstrap: sha('b'), target: null, message: null, log: [], reset: 0, checks: null, ...fields })
			return acceptDevReport(w.receiver(), receiverRequest('report', body, w.key))
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
				putAppEnvUseCase(registryContext(repositories, provider), appId, env, { ...zeropsEnvelopes(), kind: 'dev', domain: DOMAIN, ...extra })
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

			const [target] = (await listDevTargetsUseCase(w.dev())).items
			expect(target?.kind).toBe('standard')
			expect(target?.dev).toEqual(expect.objectContaining({ env: 'dev', kind: 'dev', state: 'pending', workspaceId: w.workspaceId, yours: true }))
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
			// The commit's parent is not the head the launcher holds, so the answer comes from the compare.
			const applied = followDevCommit(w.dev(), { workspaceId: w.workspaceId, commitSha: sha('c'), parentSha: sha('a'), written: [] })
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
				url: `https://${w.workspaceId}.${DOMAIN}`,
				log: [{ n: 0, stream: 'stdout', text: 'listening' }],
			})

			// A commit on the head the launcher holds hands it the written files: no GitHub read.
			const calls = w.source.calls.length
			const next = wait(w, { head: sha('c'), reset: 0, checks: 0, hold: true })
			await Bun.sleep(50)
			const written = [{ path: 'web/main.tsx', content: 'export {}\n' }, { path: 'src/gone.ts', content: null }]
			const handedOff = followDevCommit(w.dev(), { workspaceId: w.workspaceId, commitSha: sha('d'), parentSha: sha('c'), written })
			expect((await next).answer).toEqual({ sync: { from: sha('c'), to: sha('d'), files: written }, reset: 0, checks: 0 })
			expect(w.source.calls.slice(calls)).toEqual([])
			await report(w, { head: sha('d'), status: 'serving' })
			expect((await handedOff)?.state).toBe('serving')
		})

		test('Control refuses a head it cannot relay, and the launcher keeps what it serves', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			const bound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await succeedRun(dbOf(opened), bound.bootstrapRun?.id ?? '')
			w.source.changedFiles = [{ path: 'public/logo.png', previousPath: null, status: 'added', additions: 0, deletions: 0, patch: null }]
			w.source.unreadable.set('public/logo.png', 'binary')
			await w.repositories.devSandboxes.advanceTarget(w.workspaceId, sha('c'))
			expect((await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: false })).answer?.sync).toBeNull()
			const status = await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 10, failuresOnly: false } })
			expect(status.state).toBe('needs_bootstrap')
			expect(status.summary).toContain('public/logo.png is not UTF-8 text')
			// The refused head is not offered again, so a held wait does not spin.
			expect((await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: false })).answer?.sync).toBeNull()

			// bind_dev again bootstraps the refused head; the new container's report clears the refusal.
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('c'))
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('c'))
			const rebound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			expect(rebound.bootstrapRun?.commitSha).toBe(sha('c'))
			expect(w.queued).toHaveLength(2)
			// The replaced container still runs for a while: it may neither sync nor report.
			expect((await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: false })).status).toBe(409)
			await succeedRun(dbOf(opened), rebound.bootstrapRun?.id ?? '')
			expect((await report(w, { bootstrap: sha('c'), head: sha('c'), status: 'serving' })).status).toBe(204)
			expect((await report(w, { head: sha('b'), status: 'needs_bootstrap', target: sha('c'), message: 'bun.lock changed' })).status).toBe(409)
			const serving = await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 0, failuresOnly: false } })
			expect(serving.state).toBe('serving')
			expect(serving.head).toBe(sha('c'))
			expect((await w.repositories.devSandboxes.get(w.workspaceId))?.refused_sha).toBeNull()
			expect((await wait(w, { bootstrap: sha('c'), head: sha('c'), reset: 0, checks: 0, hold: false })).answer?.sync).toBeNull()
		})

		test('a sync reads a change of up to its cap in reads GitHub serves, and refuses a larger one for a bootstrap', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await succeedRun(dbOf(opened), (await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id ?? '')
			const changed = (count: number) =>
				Array.from({ length: count }, (_, i) => ({
					path: `src/generated/file-${String(i).padStart(3, '0')}.ts`,
					previousPath: null,
					status: 'added' as const,
					additions: 1,
					deletions: 0,
					patch: null,
				}))
			w.source.changedFiles = changed(DEV_SYNC_MAX_FILES)
			await w.repositories.devSandboxes.advanceTarget(w.workspaceId, sha('c'))
			const served = await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: false })
			expect(served.status).toBe(200)
			expect(served.answer?.sync?.files).toHaveLength(DEV_SYNC_MAX_FILES)

			w.source.changedFiles = changed(DEV_SYNC_MAX_FILES + 1)
			await w.repositories.devSandboxes.advanceTarget(w.workspaceId, sha('d'))
			const refused = await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: false })
			expect({ status: refused.status, sync: refused.answer?.sync }).toEqual({ status: 200, sync: null })
			const status = await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 0, failuresOnly: false } })
			expect(status.state).toBe('needs_bootstrap')
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('d'))
			expect((await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.commitSha).toBe(sha('d'))
		})

		test('a launcher without a state file learns the reset generation its database applied, then the pending one', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await succeedRun(dbOf(opened), (await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id ?? '')
			await report(w, { head: sha('b'), status: 'serving', reset: 0 })
			expect((await w.repositories.devSandboxes.advanceReset(w.workspaceId))?.reset_generation).toBe(1)

			const first = await wait(w, { head: sha('b'), reset: null, checks: null, hold: false })
			expect(first.answer?.reset).toBe(0)
			const next = await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: false })
			expect(next.answer?.reset).toBe(1)
		})

		test("a launcher's refusal is recorded, and get_dev_status reads its log window", async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await w.repositories.devSandboxes.advanceTarget(w.workspaceId, sha('c'))
			const log = [0, 1, 2].map((n) => ({ n, stream: n === 1 ? 'stderr' as const : 'stdout' as const, text: n === 1 ? 'error: line 1' : `line ${n}` }))
			await report(w, { head: sha('b'), status: 'needs_bootstrap', target: sha('c'), message: 'bun.lock changed', log })
			const row = await w.repositories.devSandboxes.get(w.workspaceId)
			expect(row?.refused_sha).toBe(sha('c'))
			const status = await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 10, failuresOnly: true } })
			expect(status.log).toEqual({ lines: [{ n: 1, stream: 'stderr', text: 'error: line 1' }], from: 0, to: 3, total: 3 })
		})

		test("a bootstrap bind drops the replaced container's check results and log", async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await succeedRun(dbOf(opened), (await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id ?? '')
			const killed = [{ name: 'tsc', ok: false, exitCode: null, durationMs: 17609, output: ['check tsc was killed (SIGKILL)'] }]
			const log: DevLogLine[] = [{ n: 0, stream: 'stdout', text: 'serving' }]
			await report(w, { head: sha('b'), status: 'serving', log, checks: { request: 1, head: sha('b'), results: killed } })
			await w.repositories.devSandboxes.recordRefusal(w.workspaceId, sha('b'), 'bun.lock changed')

			const rebound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			expect(rebound.bootstrapRun?.id).not.toBe(undefined)
			expect({ checks: rebound.checks, log: rebound.log.lines }).toEqual({ checks: null, log: [] })
		})

		test("get_dev_status indexes the log by the launcher's line numbers, so after stays put across reports", async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await succeedRun(dbOf(opened), (await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id ?? '')
			const lines = (from: number, to: number): DevLogLine[] =>
				Array.from({ length: to - from }, (_, i) => ({ n: from + i, stream: 'stdout', text: `line ${from + i}` }))
			const status = (query: { after?: number }) =>
				getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 3, failuresOnly: false, ...query } })

			await report(w, { head: sha('b'), status: 'serving', log: lines(50, 56) })
			expect((await status({})).log).toEqual({ lines: lines(53, 56), from: 53, to: 56, total: 56 })
			// The next report starts later, after a sync: the same after reads only the new lines.
			await report(w, { head: sha('b'), status: 'serving', log: lines(54, 60) })
			expect((await status({ after: 56 })).log).toEqual({ lines: lines(56, 59), from: 56, to: 59, total: 60 })
			expect((await status({ after: 10 })).log).toEqual({ lines: lines(54, 57), from: 54, to: 57, total: 60 })
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
			const results = [{ name: 'tsc', ok: true, exitCode: 0, durationMs: 1200, output: [] }]
			await report(w, { head: sha('b'), status: 'serving', checks: { request: 1, head: sha('b'), results } })
			expect((await checking).checks).toEqual({ request: 1, head: sha('b'), results })

			const resetting = resetDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			expect((await wait(w, { head: sha('b'), reset: 0, checks: 1, hold: true })).answer).toEqual({ sync: null, reset: 1, checks: 1 })
			await report(w, { head: sha('b'), status: 'serving', reset: 1 })
			expect((await resetting).state).toBe('serving')

			await w.repositories.devSandboxes.advanceTarget(w.workspaceId, sha('c'))
			await expect(runChecksUseCase(w.dev(), { workspaceId: w.workspaceId })).rejects.toThrow(
				`holds ${sha('b')}, not the workspace's newest commit ${sha('c')}`,
			)
		})

		test('a workspace without a sandbox cannot run checks, and its commits follow nothing', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await succeedRun(dbOf(opened), (await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id ?? '')
			const other = await createWorkspaceUseCase(w.dev(), { appId: 'shop', env: 'stage', title: 'Other' })
			await expect(runChecksUseCase(w.dev(), { workspaceId: other.id })).rejects.toThrow('call bind_dev first')
			await expect(resetDevUseCase(w.dev(), { workspaceId: other.id })).rejects.toThrow('call bind_dev first')
			expect(await followDevCommit(w.dev(), { workspaceId: other.id, commitSha: sha('e'), parentSha: sha('d'), written: [] })).toBeNull()
			expect((await w.repositories.devSandboxes.get(w.workspaceId))?.target_sha).toBe(sha('b'))
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
			const malformed = await acceptDevWait(w.receiver(), receiverRequest('wait', '{"head":"x"}', w.key))
			expect(malformed.status).toBe(400)
		})

		test('binding a head whose lockfile differs from what the sandbox holds starts a bootstrap run at once', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			const first = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await succeedRun(dbOf(opened), first.bootstrapRun?.id ?? '')
			await report(w, { head: sha('b'), status: 'serving' })

			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('c'))
			w.source.changedFiles = [{ path: 'src/notes/handler.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: null }]
			expect((await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id).toBe(first.bootstrapRun?.id)

			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('e'))
			w.source.changedFiles = [{ path: 'bun.lock', previousPath: null, status: 'modified', additions: 3, deletions: 3, patch: null }]
			const rebound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			expect(rebound.bootstrapRun?.commitSha).toBe(sha('e'))
			expect(rebound.state).toBe('bootstrapping')
		})

		test('a launcher this Control cannot read needs a bootstrap: apply_changes does not wait, and bind_dev bootstraps', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await succeedRun(dbOf(opened), (await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id ?? '')
			// A launcher of an older wire sends no bootstrap commit.
			const older = JSON.stringify({ head: sha('b'), reset: 0, checks: 0, hold: true })
			expect((await acceptDevWait(w.receiver(), receiverRequest('wait', older, w.key))).status).toBe(400)

			const status = await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 0, failuresOnly: false } })
			expect({ state: status.state, summary: status.summary }).toEqual({ state: 'needs_bootstrap', summary: LAUNCHER_UNREADABLE })
			const started = performance.now()
			const applied = await followDevCommit(w.dev(), { workspaceId: w.workspaceId, commitSha: sha('c'), parentSha: sha('b'), written: [] })
			expect(performance.now() - started).toBeLessThan(1_000)
			expect(applied?.state).toBe('needs_bootstrap')

			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('c'))
			const rebound = await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			expect(rebound.bootstrapRun?.commitSha).toBe(sha('c'))
			await succeedRun(dbOf(opened), rebound.bootstrapRun?.id ?? '')
			expect((await wait(w, { bootstrap: sha('c'), head: sha('c'), reset: 0, checks: 0, hold: false })).status).toBe(200)
			// Once the new container talks, an unreadable request comes from the one it replaced and changes nothing.
			expect((await acceptDevWait(w.receiver(), receiverRequest('wait', older, w.key))).status).toBe(400)
			await report(w, { bootstrap: sha('c'), head: sha('c'), status: 'serving' })
			const serving = await getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 0, failuresOnly: false } })
			expect(serving.state).toBe('serving')
		})

		test('a launcher that sends nothing for longer than it ever waits needs a bootstrap', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await succeedRun(dbOf(opened), (await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id ?? '')
			await report(w, { head: sha('b'), status: 'serving' })
			const state = async () => getDevStatusUseCase(w.dev(), { workspaceId: w.workspaceId, log: { lines: 0, failuresOnly: false } })
			w.clock.skew = 60
			expect((await state()).state).toBe('serving')
			w.clock.skew = 120
			const silent = await state()
			expect(silent.state).toBe('needs_bootstrap')
			expect(silent.summary).toContain('has sent no request')
			expect((await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.commitSha).toBe(sha('b'))
		})

		test('bind_dev of a parked sandbox waits for its launcher, and bootstraps when Control cannot read it', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await succeedRun(dbOf(opened), (await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id ?? '')
			await report(w, { head: sha('b'), status: 'serving' })
			const idle = Math.floor(Date.now() / 1000) + DEV_IDLE_STOP_SECONDS + 60

			expect(await maintainDevSandboxes(w.deps, idle)).toEqual({ parked: 1, removed: 0, failed: 0 })
			const talking = bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await Bun.sleep(1_100)
			expect((await wait(w, { head: sha('b'), reset: 0, checks: 0, hold: false })).status).toBe(200)
			expect((await talking).bootstrapRun?.commitSha).toBe(sha('b'))
			expect(w.queued).toHaveLength(1)

			// Control counts in whole seconds: the next wake is after that wait.
			await Bun.sleep(1_000)
			expect(await maintainDevSandboxes(w.deps, idle + DEV_IDLE_STOP_SECONDS + 60)).toEqual({ parked: 1, removed: 0, failed: 0 })
			const refused = bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })
			await Bun.sleep(1_100)
			const older = JSON.stringify({ head: sha('b'), reset: 0, checks: 0, hold: false })
			expect((await acceptDevWait(w.receiver(), receiverRequest('wait', older, w.key))).status).toBe(400)
			expect(w.queued).toHaveLength(1)
			await refused
			expect(w.queued).toHaveLength(2)
		})

		test('a commit by someone who may not trigger deploys does not advance or wake the dev sandbox', async () => {
			const w = await world()
			w.source.branches.set(`fabrika/${w.workspaceId}`, sha('b'))
			await succeedRun(dbOf(opened), (await bindDevUseCase(w.dev(), { workspaceId: w.workspaceId })).bootstrapRun?.id ?? '')
			const idle = Math.floor(Date.now() / 1000) + DEV_IDLE_STOP_SECONDS + 60
			expect(await maintainDevSandboxes(w.deps, idle)).toEqual({ parked: 1, removed: 0, failed: 0 })
			const calls = w.host.calls.length

			const reader = oauthUser(AUTHOR_ACTIONS.filter((action) => action !== 'deploy.trigger'), 'reader@acme.test')
			const followed = await followDevCommit(w.dev(reader), { workspaceId: w.workspaceId, commitSha: sha('c'), parentSha: sha('b'), written: [] })
			expect(followed?.state).toBe('not_followed')
			expect((await w.repositories.devSandboxes.get(w.workspaceId))?.target_sha).toBe(sha('b'))
			expect(w.host.calls.slice(calls)).toEqual([])
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
