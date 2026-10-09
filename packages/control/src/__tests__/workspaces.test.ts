// Authoring targets and Git workspaces (ADR-0049), against SQLite always and Postgres when
// FABRIKA_TEST_POSTGRES_URL is set. The repository port is a recording fake; the SQL runs against the real schema.

import { type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { afterEach, describe, expect, test } from 'bun:test'
import { putAppEnvUseCase } from '../api/registry/environments'
import {
	applyChangesUseCase,
	createPullRequestUseCase,
	createWorkspaceUseCase,
	deployStageUseCase,
	getDeploymentUseCase,
	getWorkspaceUseCase,
	isProtectedPath,
	listFilesUseCase,
	listTargetsUseCase,
	listWorkspacesUseCase,
	readFilesUseCase,
} from '../api/workspaces'
import { type ControlRepositories, createControlRepositories } from '../db'
import { createHarness } from './helpers/harness'
import { fixtureRuns } from './helpers/lock'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'
import { fakeControlProvider } from './helpers/provider'
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
} from './helpers/workspaces'

if (!hasPostgres) console.warn(`workspaces.test.ts Postgres half ${skipReason}`)

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
			const fixture = await createPostgres('vozka_ws')
			return { repositories: createControlRepositories(fixture.db), db: fixture.db, close: () => fixture.close() }
		},
	},
]

const author = oauthUser(AUTHOR_ACTIONS)

for (const backend of backends) {
	describe.skipIf(backend.skip)(`authoring workspaces (${backend.name})`, () => {
		let opened: Backend | null = null
		afterEach(async () => {
			await opened?.close()
			opened = null
		})

		function requireOpened(): Backend {
			if (opened === null) throw new Error('no backend is open')
			return opened
		}

		async function world(): Promise<WorkspaceWorld> {
			opened = await backend.open()
			return seedWorkspaceWorld(opened.repositories, opened.db)
		}

		async function workspace(w: WorkspaceWorld) {
			return createWorkspaceUseCase(w.context(author), { appId: 'shop', env: 'stage', title: 'Add a banner' })
		}

		describe('the authoring flag', () => {
			test('is exposed, preserved when omitted, and cleared explicitly', async () => {
				const w = await world()
				const registry = registryContext(w.repositories)
				expect((await w.repositories.registry.getAppEnv('shop', 'stage'))?.authoring).toBe(1)
				expect((await w.repositories.registry.getAppEnv('shop', 'prod'))?.authoring).toBe(0)
				const preserved = await putAppEnvUseCase(registry, 'shop', 'stage', { ...zeropsEnvelopes(), triggerRef: 'refs/heads/stage' })
				expect(preserved.authoring).toBe(true)
				expect(preserved.triggerRef).toBe('refs/heads/stage')
				const cleared = await putAppEnvUseCase(registry, 'shop', 'stage', { ...zeropsEnvelopes(), authoring: false })
				expect(cleared.authoring).toBe(false)
			})

			test('refuses an app without a GitHub connection', async () => {
				const w = await world()
				await expect(putAppEnvUseCase(registryContext(w.repositories), 'plain', 'stage', { ...zeropsEnvelopes(), authoring: true }))
					.rejects.toMatchObject({ httpStatus: 409 })
				expect((await w.repositories.registry.getAppEnv('plain', 'stage'))?.authoring).toBe(0)
			})

			test('allows one authoring environment per app', async () => {
				const w = await world()
				const registry = registryContext(w.repositories)
				await expect(putAppEnvUseCase(registry, 'shop', 'prod', { ...zeropsEnvelopes(), authoring: true })).rejects.toMatchObject({
					httpStatus: 409,
				})
				expect((await w.repositories.registry.getAppEnv('shop', 'prod'))?.authoring).toBe(0)
				expect((await putAppEnvUseCase(registry, 'shop', 'stage', { ...zeropsEnvelopes(), authoring: true })).authoring).toBe(true)
				await putAppEnvUseCase(registry, 'shop', 'stage', { ...zeropsEnvelopes(), authoring: false })
				expect((await putAppEnvUseCase(registry, 'shop', 'prod', { ...zeropsEnvelopes(), authoring: true })).authoring).toBe(true)
			})

			test('refuses a provider other than Zerops', async () => {
				const w = await world()
				await expect(
					putAppEnvUseCase(registryContext(w.repositories, fakeControlProvider), 'shop', 'prod', { ...zeropsEnvelopes(), authoring: true }),
				).rejects.toMatchObject({ httpStatus: 409 })
			})
		})

		describe('targets', () => {
			test('lists only authoring environments the caller may read', async () => {
				const w = await world()
				expect(await listTargetsUseCase(w.context(author))).toEqual({
					items: [{ appId: 'shop', env: 'stage', repository: 'acme/shop', defaultBranch: 'main', publicOrigin: 'https://shop-stage.example.com' }],
				})
				expect(await listTargetsUseCase(w.context(oauthUser(['deploy.read'])))).toEqual({ items: [] })
			})
		})

		describe('workspaces', () => {
			test('create branches from the default head through the app source binding', async () => {
				const w = await world()
				const created = await workspace(w)
				expect(created.branch).toBe(`fabrika/${created.id}`)
				expect(created.baseSha).toBe(sha('a'))
				expect(created.headSha).toBe(sha('a'))
				expect(w.source.calls).toEqual([
					{ kind: 'read-branch', branch: 'main' },
					{ kind: 'create-branch', branch: created.branch, fromSha: sha('a') },
				])
				expect(w.source.targets[0]).toEqual({ connectionId: CONNECTION_ID, installationId: INSTALLATION_ID, owner: 'acme', repository: 'shop' })
				const stored = await w.repositories.workspaces.getWorkspace(created.id)
				expect(stored?.owner_id).toBe(author.principal?.id)
			})

			test('are visible to their owner only', async () => {
				const w = await world()
				const created = await workspace(w)
				const stranger = oauthUser(AUTHOR_ACTIONS, 'stranger@acme.test')
				await expect(getWorkspaceUseCase(w.context(stranger), { workspaceId: created.id })).rejects.toMatchObject({ httpStatus: 404 })
				expect(await listWorkspacesUseCase(w.context(stranger), {})).toEqual({ items: [] })
				expect((await listWorkspacesUseCase(w.context(author), { appId: 'shop' })).items.map((item) => item.id)).toEqual([created.id])
			})

			test('each action is checked at the target coordinates and a denial is a 404', async () => {
				const w = await world()
				const created = await workspace(w)
				const reader = oauthUser(['source.workspace.read'])
				await expect(createWorkspaceUseCase(w.context(reader), { appId: 'shop', env: 'stage', title: 't' })).rejects.toMatchObject({
					httpStatus: 404,
				})
				const sameOwnerReader = oauthUser(['source.workspace.read'], 'author@acme.test')
				const id = { workspaceId: created.id }
				await expect(applyChangesUseCase(w.context(sameOwnerReader), {
					...id,
					expectedHeadSha: sha('a'),
					message: 'm',
					changes: [{ path: 'a.txt', content: 'a' }],
				})).rejects.toMatchObject({ httpStatus: 404 })
				await expect(deployStageUseCase(w.context(sameOwnerReader), id)).rejects.toMatchObject({ httpStatus: 404 })
				await expect(createPullRequestUseCase(w.context(sameOwnerReader), { ...id, title: 't', body: '' })).rejects.toMatchObject({ httpStatus: 404 })
				const writerOnly = oauthUser(['source.workspace.write'], 'author@acme.test')
				await expect(getWorkspaceUseCase(w.context(writerOnly), id)).rejects.toMatchObject({ httpStatus: 404 })
				expect(w.source.kinds()).toEqual(['read-branch', 'create-branch'])
				expect(w.queued).toEqual([])
			})

			test('a target that stops being an authoring environment is refused', async () => {
				const w = await world()
				const created = await workspace(w)
				await putAppEnvUseCase(registryContext(w.repositories), 'shop', 'stage', { ...zeropsEnvelopes(), authoring: false })
				await expect(getWorkspaceUseCase(w.context(author), { workspaceId: created.id })).rejects.toMatchObject({ httpStatus: 404 })
				await expect(createWorkspaceUseCase(w.context(author), { appId: 'shop', env: 'stage', title: 't' })).rejects.toMatchObject({
					httpStatus: 404,
				})
				await expect(createWorkspaceUseCase(w.context(author), { appId: 'shop', env: 'prod', title: 't' })).rejects.toMatchObject({
					httpStatus: 404,
				})
			})

			test('files are read at the live head unless a commit is named', async () => {
				const w = await world()
				const created = await workspace(w)
				expect((await listFilesUseCase(w.context(author), { workspaceId: created.id })).commitSha).toBe(sha('a'))
				const read = await readFilesUseCase(w.context(author), { workspaceId: created.id, paths: ['README.md'], commitSha: sha('b') })
				expect(read).toEqual({ commitSha: sha('b'), files: [{ path: 'README.md', content: 'content of README.md' }] })
			})
		})

		describe('changes', () => {
			test('commit as the principal with Fabrika trailers', async () => {
				const w = await world()
				const created = await workspace(w)
				const result = await applyChangesUseCase(w.context(author), {
					workspaceId: created.id,
					expectedHeadSha: sha('a'),
					message: 'Add a banner',
					changes: [{ path: 'src/banner.ts', content: 'export {}' }, { path: 'old.txt', content: null }],
				})
				expect(result.commitSha).toBe(sha('1'))
				const commit = w.source.calls.at(-1)
				expect(commit).toEqual({
					kind: 'commit',
					commit: {
						branch: created.branch,
						expectedHeadSha: sha('a'),
						message: `Add a banner\n\nFabrika-Principal: ${author.principal?.id}\nFabrika-Client: https://claude.ai/oauth/client.json`,
						author: { name: 'author@acme.test', email: `${author.principal?.id}@users.noreply.fabrika` },
						changes: [{ path: 'src/banner.ts', content: 'export {}' }, { path: 'old.txt', content: null }],
					},
				})
			})

			test('protected paths are refused before GitHub is called', async () => {
				const w = await world()
				const created = await workspace(w)
				for (
					const path of [
						'zerops.yaml',
						'apps/web/zerops.yml',
						'fabrika.config.ts',
						'pkg/fabrika.service.ts',
						'.github/workflows/ci.yml',
						'.github/actions/x/action.yml',
					]
				) {
					await expect(applyChangesUseCase(w.context(author), {
						workspaceId: created.id,
						expectedHeadSha: sha('a'),
						message: 'm',
						changes: [{ path: 'ok.txt', content: '' }, { path, content: 'x' }],
					})).rejects.toMatchObject({ httpStatus: 403 })
				}
				expect(w.source.kinds()).toEqual(['read-branch', 'create-branch'])
				expect(isProtectedPath('fabrika.contract.ts')).toBe(false)
				expect(isProtectedPath('Fabrika.Contract.ts')).toBe(true)
				expect(isProtectedPath('src/db/tables.ts')).toBe(false)
				expect(isProtectedPath('db/migrations/20260101000000_init.sql')).toBe(false)
				expect(isProtectedPath('docs/zerops.yaml.md')).toBe(false)
				expect(isProtectedPath('.github/dependabot.yml')).toBe(true)
				expect(isProtectedPath('docs/.github/notes.md')).toBe(false)
			})

			test('a message that would exceed the commit-message bound with its trailers is refused before GitHub', async () => {
				const w = await world()
				const created = await workspace(w)
				await expect(applyChangesUseCase(w.context(author), {
					workspaceId: created.id,
					expectedHeadSha: sha('a'),
					message: 'x'.repeat(8 * 1024 - 10),
					changes: [{ path: 'a.txt', content: 'a' }],
				})).rejects.toMatchObject({ httpStatus: 400 })
				expect(w.source.kinds()).toEqual(['read-branch', 'create-branch'])
			})

			test('a stale expected head fails with the new head', async () => {
				const w = await world()
				const created = await workspace(w)
				w.source.branches.set(created.branch, sha('e'))
				await expect(applyChangesUseCase(w.context(author), {
					workspaceId: created.id,
					expectedHeadSha: sha('a'),
					message: 'm',
					changes: [{ path: 'a.txt', content: 'a' }],
				})).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining(sha('e')) })
			})
		})

		describe('stage deploys and pull requests', () => {
			test('a stage deploy creates exactly one pending run for the pinned head and enqueues it', async () => {
				const w = await world()
				const created = await workspace(w)
				const run = await deployStageUseCase(w.context(author), { workspaceId: created.id })
				expect(run).toMatchObject({
					appId: 'shop',
					env: 'stage',
					ref: `refs/heads/${created.branch}`,
					commitSha: sha('a'),
					trigger: 'manual',
					status: 'pending',
				})
				expect(w.queued).toEqual([{ runId: run.id }])
				expect((await w.repositories.runs.listRuns({ appId: 'shop', limit: 10 })).map((row) => row.id)).toEqual([run.id])
				expect((await getWorkspaceUseCase(w.context(author), { workspaceId: created.id })).latestRun?.id).toBe(run.id)

				w.logs.set(`runs/${run.id}/logs.ndjson`, [{ ts: 1, stream: 'meta', text: 'building' }])
				expect(await getDeploymentUseCase(w.context(author), { runId: run.id })).toEqual({
					run,
					logTail: [{ ts: 1, stream: 'meta', text: 'building' }],
					approval: null,
				})
				await expect(getDeploymentUseCase(w.context(oauthUser(['source.workspace.read'])), { runId: run.id })).rejects.toMatchObject({
					httpStatus: 404,
				})
			})

			test('a run parked for approval is reported with the approval link and the change, which no MCP token can approve', async () => {
				const w = await world()
				const created = await workspace(w)
				const run = await deployStageUseCase(w.context(author), { workspaceId: created.id })
				const classification = {
					outcome: 'widening',
					changes: [{ widens: true, line: 'Role `editor` gains `notes.delete`' }],
					candidateDigest: `sha256:${'a'.repeat(64)}`,
					baselineDigest: `sha256:${'b'.repeat(64)}`,
					baselineRunId: null,
					protected: true,
				}
				const owned = fixtureRuns(w.repositories.runs, new SqlDeployLocks(requireOpened().db))
				await owned.start(run.id, `runs/${run.id}/logs.ndjson`)
				await owned.park(run.id, JSON.stringify(classification))

				const deployment = await getDeploymentUseCase(w.context(author), { runId: run.id })
				expect(deployment.run.status).toBe('awaiting_approval')
				expect(deployment.approval).toEqual({
					url: `https://console.example.test/approvals/${run.id}`,
					changes: ['Role `editor` gains `notes.delete`'],
				})
			})

			test('the live head is read once and pinned', async () => {
				const w = await world()
				const created = await workspace(w)
				w.source.branches.set(created.branch, sha('f'))
				const before = w.source.calls.length
				const run = await deployStageUseCase(w.context(author), { workspaceId: created.id })
				expect(run.commitSha).toBe(sha('f'))
				expect(w.source.calls.slice(before)).toEqual([{ kind: 'read-branch', branch: created.branch }])
			})

			test('a deployment is readable only through the caller own workspace', async () => {
				const w = await world()
				const created = await workspace(w)
				const own = await deployStageUseCase(w.context(author), { workspaceId: created.id })
				const stranger = oauthUser(AUTHOR_ACTIONS, 'stranger@acme.test')
				const theirs = await createWorkspaceUseCase(w.context(stranger), { appId: 'shop', env: 'stage', title: 'Theirs' })
				const foreign = await deployStageUseCase(w.context(stranger), { workspaceId: theirs.id })
				const prod = await w.repositories.runs.createRun({
					id: uuidv7(),
					appId: 'shop',
					env: 'prod',
					ref: 'refs/heads/main',
					trigger: 'manual',
					actor: 'user:test',
				})
				for (const runId of [foreign.id, prod.id, 'missing']) {
					await expect(getDeploymentUseCase(w.context(author), { runId })).rejects.toMatchObject({ httpStatus: 404 })
				}
				expect((await getDeploymentUseCase(w.context(author), { runId: own.id })).run.id).toBe(own.id)
				await putAppEnvUseCase(registryContext(w.repositories), 'shop', 'stage', { ...zeropsEnvelopes(), authoring: false })
				await expect(getDeploymentUseCase(w.context(author), { runId: own.id })).rejects.toMatchObject({ httpStatus: 404 })
			})

			test('a pull request goes from the workspace branch to the default branch', async () => {
				const w = await world()
				const created = await workspace(w)
				const pullRequest = await createPullRequestUseCase(w.context(author), { workspaceId: created.id, title: 'Banner', body: 'Adds it.' })
				expect(pullRequest).toEqual({ number: 7, url: 'https://github.com/acme/shop/pull/7', created: true })
				expect(w.source.calls.at(-1)).toEqual({
					kind: 'pull-request',
					pullRequest: { head: created.branch, base: 'main', title: 'Banner', body: 'Adds it.' },
				})
			})
		})
	})
}
