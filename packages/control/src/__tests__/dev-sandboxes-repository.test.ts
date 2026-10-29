// The per-workspace dev sandbox record, the workspace a transport key names and the IAM digest column, against SQLite
// always and Postgres when FABRIKA_TEST_POSTGRES_URL is set: the SQL runs against the shipped migrations of each dialect.

import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories, type DevSandboxRow } from '../db'
import { createHarness, type Harness } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const T0 = 1_800_000_000

function devSandboxesContract(database: () => SqlDatabase): void {
	let clock = T0
	let repositories: ControlRepositories
	let appId: string

	beforeEach(async () => {
		clock = T0
		repositories = createControlRepositories(database(), { now: () => clock })
		appId = `app${uuidv7().replaceAll('-', '').slice(-12)}`
		await repositories.registry.createApp({ id: appId, repoUrl: `github.com/acme/${appId}` })
		await repositories.registry.upsertAppEnv({
			appId,
			env: 'dev',
			namespaceId: null,
			provider: 'test',
			providerTargetJson: '{}',
			providerArtifactJson: '{}',
		})
	})

	async function workspace(): Promise<string> {
		const id = uuidv7()
		await repositories.workspaces.createWorkspace({
			id,
			appId,
			env: 'dev',
			ownerId: 'user:ada',
			branch: `fabrika/${id}`,
			baseSha: 'a'.repeat(40),
			title: 't',
		})
		return id
	}

	async function readySandbox(): Promise<string> {
		const workspaceId = await workspace()
		await repositories.devSandboxes.insertCreating({ workspaceId, appId, env: 'dev', now: clock })
		await repositories.devSandboxes.markReady({
			workspaceId,
			sandboxId: `sbx-${workspaceId}`,
			baseDigest: 'sha256:base',
			upstreamHost: `3000-sbx.${workspaceId}.box`,
			proxySecretRef: `vault:${workspaceId}`,
		})
		return workspaceId
	}

	test('a sandbox is recorded once per workspace, and needs the workspace', async () => {
		const sandboxes = repositories.devSandboxes
		expect(await sandboxes.insertCreating({ workspaceId: uuidv7(), appId, env: 'dev', now: T0 })).toBeNull()
		const workspaceId = await workspace()
		const created = await sandboxes.insertCreating({ workspaceId, appId, env: 'dev', now: T0 })
		if (created === null) throw new Error('expected the sandbox to be recorded')
		expect(created).toMatchObject({ workspace_id: workspaceId, app_id: appId, env: 'dev', state: 'creating', sandbox_id: null, status: 'unbound' })
		expect(created).toMatchObject({ log_json: '[]', reset_generation: 0, checks_generation: 0, activity_at: T0, parked_at: null })
		expect(typeof created.created_at).toBe('number')
		// A bind of a recorded sandbox counts as activity.
		expect(await sandboxes.insertCreating({ workspaceId, appId, env: 'dev', now: T0 + 50 })).toEqual({ ...created, activity_at: T0 + 50 })

		const ready = await sandboxes.markReady({
			workspaceId,
			sandboxId: 'sbx-1',
			baseDigest: 'sha256:b',
			upstreamHost: '3000-sbx-1.box',
			proxySecretRef: 'vault:p',
		})
		expect(ready).toMatchObject({
			state: 'ready',
			sandbox_id: 'sbx-1',
			base_digest: 'sha256:b',
			upstream_host: '3000-sbx-1.box',
			proxy_secret_ref: 'vault:p',
		})
		expect(await sandboxes.get(workspaceId)).toEqual(ready)
		expect(await sandboxes.get(uuidv7())).toBeNull()

		const other = await readySandbox()
		expect((await sandboxes.listByEnvironment(appId, 'dev')).map((row) => row.workspace_id)).toEqual([workspaceId, other].sort())
		expect(await sandboxes.listByEnvironment(appId, 'prod')).toEqual([])
	})

	test('a removing sandbox is neither made ready nor bootstrapped, and is deleted once', async () => {
		const sandboxes = repositories.devSandboxes
		const workspaceId = await readySandbox()
		const removing = await sandboxes.markRemoving(workspaceId)
		expect(removing).toMatchObject({ state: 'removing', sandbox_id: `sbx-${workspaceId}` })
		expect(await sandboxes.markReady({ workspaceId, sandboxId: 'other', baseDigest: 'd', upstreamHost: 'h', proxySecretRef: 'r' })).toBeNull()
		expect(await sandboxes.startBootstrap({ workspaceId, runId: uuidv7(), targetSha: 'b'.repeat(40), now: T0 })).toBeNull()
		expect(await sandboxes.delete(workspaceId)).toBe(true)
		expect(await sandboxes.delete(workspaceId)).toBe(false)
		expect(await sandboxes.markRemoving(workspaceId)).toBeNull()
	})

	test('a bootstrap clears what the previous build held, refused, logged or checked', async () => {
		const sandboxes = repositories.devSandboxes
		const workspaceId = await readySandbox()
		await sandboxes.advanceChecks(workspaceId)
		await sandboxes.recordReport(workspaceId, {
			head: 'c'.repeat(40),
			status: 'serving',
			refused: 'd'.repeat(40),
			message: 'needs a bootstrap',
			logJson: '[{"line":"x"}]',
			resetApplied: 0,
			checksJson: '{"ok":true}',
		})
		await sandboxes.recordLauncherRefused(workspaceId, 'unreadable', T0 + 100)
		const runId = uuidv7()
		const bootstrapped = await sandboxes.startBootstrap({ workspaceId, runId, targetSha: 'e'.repeat(40), now: T0 + 10 })
		expect(bootstrapped).toMatchObject({
			bootstrap_run_id: runId,
			target_sha: 'e'.repeat(40),
			refused_sha: null,
			status: 'unbound',
			message: null,
			launcher_refused: null,
			checks_json: null,
			log_json: '[]',
			activity_at: T0 + 10,
			head_sha: 'c'.repeat(40),
			checks_generation: 1,
		})
		const published = uuidv7()
		expect(await sandboxes.recordPublishedRun(workspaceId, published)).toBe(true)
		expect(await sandboxes.recordPublishedRun(uuidv7(), published)).toBe(false)
		expect((await sandboxes.get(workspaceId))?.published_run_id).toBe(published)
	})

	test('the launcher signals of one workspace leave the others alone', async () => {
		const sandboxes = repositories.devSandboxes
		const workspaceId = await readySandbox()
		const other = await readySandbox()
		clock = T0 + 5
		expect(await sandboxes.advanceTarget(workspaceId, 'f'.repeat(40))).toMatchObject({ target_sha: 'f'.repeat(40), activity_at: T0 + 5 })
		expect(await sandboxes.advanceTarget(uuidv7(), 'f'.repeat(40))).toBeNull()
		expect(await sandboxes.advanceReset(workspaceId)).toMatchObject({ reset_generation: 1 })
		expect(await sandboxes.advanceChecks(workspaceId)).toMatchObject({ checks_generation: 1, checks_json: null })
		await sandboxes.recordRefusal(workspaceId, 'f'.repeat(40), 'too many files')
		expect(await sandboxes.get(workspaceId)).toMatchObject({
			refused_sha: 'f'.repeat(40),
			status: 'needs_bootstrap',
			message: 'too many files',
			reported_at: T0 + 5,
		})
		expect(await sandboxes.get(other)).toMatchObject({
			target_sha: null,
			reset_generation: 0,
			checks_generation: 0,
			refused_sha: null,
			status: 'unbound',
		})

		// A report holding the refused head clears the refusal; results of checks survive a report without any.
		clock = T0 + 9
		const report = { status: 'serving', refused: null, message: null, logJson: '[]', resetApplied: 1, checksJson: '{"ok":true}' }
		expect(await sandboxes.recordReport(workspaceId, { ...report, head: 'f'.repeat(40) })).toMatchObject({
			head_sha: 'f'.repeat(40),
			refused_sha: null,
			reset_applied: 1,
			checks_json: '{"ok":true}',
			reported_at: T0 + 9,
			launcher_seen_at: T0 + 9,
		})
		expect(await sandboxes.recordReport(workspaceId, { ...report, head: 'f'.repeat(40), checksJson: null })).toMatchObject({
			checks_json: '{"ok":true}',
		})

		// A refusal is recorded only while no request was accepted since the launcher started.
		expect(await sandboxes.recordLauncherRefused(workspaceId, 'unreadable', T0 + 9)).toBe(false)
		expect(await sandboxes.recordLauncherRefused(workspaceId, 'unreadable', T0 + 10)).toBe(true)
		expect((await sandboxes.get(workspaceId))?.launcher_refused).toBe('unreadable')
		clock = T0 + 11
		await sandboxes.recordLauncherSeen(workspaceId)
		expect(await sandboxes.get(workspaceId)).toMatchObject({ launcher_refused: null, launcher_seen_at: T0 + 11 })
	})

	test('an idle ready sandbox is parked once, woken by a request, and listed stale after its activity', async () => {
		const sandboxes = repositories.devSandboxes
		// The lists span every environment of the database; earlier tests' rows stay on the shared Postgres schema.
		const ownIds = (rows: DevSandboxRow[]) => rows.filter((row) => row.app_id === appId).map((row) => row.workspace_id)
		const idle = await readySandbox()
		clock = T0 + 100
		const busy = await readySandbox()
		await sandboxes.advanceTarget(busy, 'a'.repeat(40))
		const creating = await workspace()
		await sandboxes.insertCreating({ workspaceId: creating, appId, env: 'dev', now: T0 })

		expect(ownIds(await sandboxes.listIdle(T0 + 50))).toEqual([idle])
		expect(await sandboxes.markParked(busy, T0 + 50)).toBe(false)
		expect(await sandboxes.markParked(idle, T0 + 50)).toBe(true)
		expect(await sandboxes.markParked(idle, T0 + 50)).toBe(false)
		expect((await sandboxes.get(idle))?.parked_at).toBe(T0 + 100)
		expect(ownIds(await sandboxes.listIdle(T0 + 50))).toEqual([])

		await sandboxes.clearParked(idle)
		expect(ownIds(await sandboxes.listIdle(T0 + 50))).toEqual([idle])
		await sandboxes.markParked(idle, T0 + 50)

		clock = T0 + 200
		expect(await sandboxes.markWoke(busy)).toBe(false)
		expect(await sandboxes.markWoke(idle)).toBe(true)
		expect(await sandboxes.get(idle)).toMatchObject({ parked_at: null, woke_at: T0 + 200, activity_at: T0 + 200 })

		await sandboxes.markParked(busy, T0 + 300)
		await sandboxes.recordLauncherSeen(busy)
		expect((await sandboxes.get(busy))?.parked_at).toBeNull()

		expect(ownIds(await sandboxes.listStale(T0 + 50))).toEqual([creating])
		expect(ownIds(await sandboxes.listStale(T0 + 201))).toEqual([busy, creating, idle].sort())
	})

	test('maintenance marks only a removable sandbox, and lists the removing and the abandoned', async () => {
		const sandboxes = repositories.devSandboxes
		const ownIds = (rows: DevSandboxRow[]) => rows.filter((row) => row.app_id === appId).map((row) => row.workspace_id)
		const active = await readySandbox()
		expect(await sandboxes.markRemovingIfRemovable(active, T0, T0)).toBeNull()
		expect((await sandboxes.get(active))?.state).toBe('ready')
		expect((await sandboxes.markRemovingIfRemovable(active, T0 + 1, T0))?.state).toBe('removing')
		expect(await sandboxes.markRemovingIfRemovable(active, T0 - 100, T0 - 100)).not.toBeNull()
		expect(ownIds(await sandboxes.listRemoving())).toEqual([active])

		const abandoned = await readySandbox()
		await repositories.workspaces.markAbandoned(abandoned)
		expect(ownIds(await sandboxes.listOfAbandonedWorkspaces())).toEqual([abandoned])
		expect(await sandboxes.markRemovingIfRemovable(abandoned, T0 - 100, T0 - 100)).not.toBeNull()
		// An abandoned workspace gets no sandbox, and its existing one is not handed out again.
		expect(await sandboxes.insertCreating({ workspaceId: abandoned, appId, env: 'dev', now: T0 })).toBeNull()
		const late = await workspace()
		await repositories.workspaces.markAbandoned(late)
		expect(await sandboxes.insertCreating({ workspaceId: late, appId, env: 'dev', now: T0 })).toBeNull()
		expect(await sandboxes.get(late)).toBeNull()
	})

	test('a create left behind is removable once it saw no bind for a while; a failed create marks only a row without a sandbox', async () => {
		const sandboxes = repositories.devSandboxes
		const ownIds = (rows: DevSandboxRow[]) => rows.filter((row) => row.app_id === appId).map((row) => row.workspace_id)
		const stuck = await workspace()
		await sandboxes.insertCreating({ workspaceId: stuck, appId, env: 'dev', now: T0 })
		expect(ownIds(await sandboxes.listCreatingBefore(T0))).toEqual([])
		expect(ownIds(await sandboxes.listCreatingBefore(T0 + 1))).toEqual([stuck])
		expect(await sandboxes.markRemovingIfRemovable(stuck, T0 - 100, T0)).toBeNull()
		// A retried bind counts as activity, so the create it runs is not taken from under it.
		await sandboxes.insertCreating({ workspaceId: stuck, appId, env: 'dev', now: T0 + 10 })
		expect(await sandboxes.markRemovingIfRemovable(stuck, T0 - 100, T0 + 1)).toBeNull()
		expect((await sandboxes.markRemovingIfRemovable(stuck, T0 - 100, T0 + 11))?.state).toBe('removing')

		const ready = await readySandbox()
		expect(await sandboxes.markRemovingIfRemovable(ready, T0 - 100, T0 + 100)).toBeNull()
		expect(await sandboxes.markRemovingIfUncreated(ready)).toBeNull()
		expect((await sandboxes.get(ready))?.state).toBe('ready')
		const failed = await workspace()
		await sandboxes.insertCreating({ workspaceId: failed, appId, env: 'dev', now: T0 })
		expect((await sandboxes.markRemovingIfUncreated(failed))?.state).toBe('removing')
	})

	test('sandboxes go with their environment', async () => {
		const workspaceId = await readySandbox()
		await repositories.registry.deleteAppEnv(appId, 'dev')
		expect(await repositories.devSandboxes.get(workspaceId)).toBeNull()
	})

	test('a transport key names the workspace it authenticates, and other keys name none', async () => {
		const workspaceId = await workspace()
		const key = (id: string, hash: string) => ({
			app_id: appId,
			env: 'dev',
			receiver: 'source',
			key_id: id,
			key_hash: `${hash}-${appId}`,
			value_ref: `vault:${id}`,
			expires_at: T0 + 100,
			created_at: T0,
		})
		const keys = repositories.platformTransportKeys
		// A workspace's key is recorded only while the workspace has a sandbox in the environment that is not being removed.
		expect(await keys.insert({ ...key('k0', 'h0'), workspace_id: workspaceId })).toBe(false)
		await repositories.devSandboxes.insertCreating({ workspaceId, appId, env: 'dev', now: T0 })
		expect(await keys.insert({ ...key('k1', 'h1'), workspace_id: workspaceId })).toBe(true)
		expect(await keys.insert(key('k2', 'h2'))).toBe(true)
		expect(await keys.insert({ ...key('k3', 'h3'), workspace_id: uuidv7() })).toBe(false)
		expect((await keys.findValidByHash(`h1-${appId}`, T0))?.workspace_id).toBe(workspaceId)
		expect((await keys.findValidByHash(`h2-${appId}`, T0))?.workspace_id).toBeNull()
		expect(await keys.findValidByHash(`h0-${appId}`, T0)).toBeNull()
		await repositories.devSandboxes.markRemoving(workspaceId)
		expect(await keys.insert({ ...key('k4', 'h4'), workspace_id: workspaceId })).toBe(false)
		expect(await keys.findValidByHash(`h4-${appId}`, T0)).toBeNull()
	})

	test('an environment starts with no IAM digest', async () => {
		const row = await database().prepare('SELECT iam_digest FROM app_envs WHERE app_id = ? AND env = ?').bind(appId, 'dev').first<
			{ iam_digest: string | null }
		>()
		expect(row).toEqual({ iam_digest: null })
	})
}

describe('dev sandboxes on SQLite', () => {
	let harness: Harness
	beforeEach(() => {
		harness = createHarness()
	})
	afterEach(() => harness.sqlite.close())

	devSandboxesContract(() => harness.d1)
})

if (!hasPostgres) console.warn(`dev-sandboxes-repository.test.ts ${skipReason}`)

let fixture: PostgresFixture
beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('dev_sandboxes')
})
afterAll(async () => {
	if (hasPostgres) await fixture.close()
})

describe.skipIf(!hasPostgres)('dev sandboxes on Postgres', () => {
	devSandboxesContract(() => fixture.db)
})
