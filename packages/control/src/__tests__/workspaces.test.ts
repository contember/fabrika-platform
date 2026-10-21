// Authoring targets and Git workspaces (ADR-0049), against SQLite always and Postgres when
// FABRIKA_TEST_POSTGRES_URL is set. The repository port is a recording fake; the SQL runs against the real schema.

import type { RunLogLine } from '@fabrika/control-contract'
import { type SqlDatabase, SqlDeployLocks, uuidv7 } from '@fabrika/platform'
import { afterEach, describe, expect, test } from 'bun:test'
import { putAppEnvUseCase } from '../api/registry/environments'
import {
	applyChangesUseCase,
	createPullRequestUseCase,
	createWorkspaceUseCase,
	type DeploymentLogQuery,
	deployStageUseCase,
	getDeploymentUseCase,
	getWorkspaceDiffUseCase,
	getWorkspaceUseCase,
	isProtectedPath,
	listFilesUseCase,
	listTargetsUseCase,
	listWorkspacesUseCase,
	readFilesUseCase,
	SEARCH_MAX_FILES,
	searchFilesUseCase,
} from '../api/workspaces'
import { type ControlRepositories, createControlRepositories } from '../db'
import { type WorkspaceChangedFile, WorkspaceSourceError } from '../workspace-source-port'
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
const TAIL = { lines: 30, failuresOnly: false }

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

			test('a GitHub refusal says a retry will not help, and an outage says it may', async () => {
				const w = await world()
				const created = await workspace(w)
				w.source.failure = new WorkspaceSourceError('refused')
				await expect(getWorkspaceUseCase(w.context(author), { workspaceId: created.id })).rejects.toMatchObject({
					httpStatus: 502,
					message: expect.stringContaining('Retrying will not help; tell the operator.'),
				})
				w.source.failure = new WorkspaceSourceError('unavailable')
				await expect(getWorkspaceUseCase(w.context(author), { workspaceId: created.id })).rejects.toMatchObject({
					httpStatus: 503,
					message: expect.stringContaining('Retry in a minute'),
				})
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
				expect((await listFilesUseCase(w.context(author), { workspaceId: created.id, offset: 0, limit: 10 })).commitSha).toBe(sha('a'))
				const read = await readFilesUseCase(w.context(author), { workspaceId: created.id, paths: ['README.md'], commitSha: sha('b') })
				expect(read).toEqual({ commitSha: sha('b'), files: [{ path: 'README.md', content: 'content of README.md' }] })
				w.source.unreadable.set('logo.png', 'binary')
				expect((await readFilesUseCase(w.context(author), { workspaceId: created.id, paths: ['logo.png'] })).files).toEqual([
					{ path: 'logo.png', content: null, reason: 'binary' },
				])
			})
		})

		describe('listing', () => {
			test('depth keeps the levels below the directory, and a page ends with the offset of the next one', async () => {
				const w = await world()
				const created = await workspace(w)
				for (const path of ['src/a.ts', 'src/lib/b.ts', 'src/lib/deep/c.ts', 'src/z.ts']) w.source.contents.set(path, '')
				const list = (input: { directory?: string; depth?: number; offset?: number; limit?: number }) =>
					listFilesUseCase(w.context(author), { workspaceId: created.id, offset: 0, limit: 100, ...input })
				expect((await list({ directory: 'src', depth: 1 })).entries.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/z.ts'])
				expect((await list({ depth: 2 })).entries.map((entry) => entry.path)).toEqual(['src', 'src/a.ts', 'src/z.ts'])
				expect((await list({ depth: 1 })).entries.map((entry) => entry.path)).toEqual(['src'])
				expect(await list({ limit: 2 })).toEqual({
					commitSha: sha('a'),
					entries: [{ path: 'src', kind: 'directory' }, { path: 'src/a.ts', kind: 'file', size: 1 }],
					truncated: false,
					nextOffset: 2,
				})
				expect((await list({ offset: 4, limit: 2 })).nextOffset).toBeNull()
			})
		})

		describe('diff', () => {
			const changed = (path: string, patch: string | null): WorkspaceChangedFile => ({
				path,
				previousPath: null,
				status: 'modified',
				additions: 1,
				deletions: 1,
				patch,
			})

			test('compares the live head with the workspace base and leaves patches out unless asked', async () => {
				const w = await world()
				const created = await workspace(w)
				w.source.branches.set(created.branch, sha('f'))
				w.source.changedFiles = [changed('src/a.ts', '@@ -1 +1 @@')]
				const diff = await getWorkspaceDiffUseCase(w.context(author), { workspaceId: created.id, includePatches: false })
				expect(diff).toEqual({
					baseSha: sha('a'),
					headSha: sha('f'),
					commitsAhead: 1,
					files: [{ path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1 }],
					incomplete: [],
				})
				expect(w.source.calls.at(-1)).toEqual({ kind: 'compare', baseSha: sha('a'), headSha: sha('f') })
			})

			test('patches are bounded per file and in total, and paths narrows which files carry one', async () => {
				const w = await world()
				const created = await workspace(w)
				const patch = (size: number) => `+${'x'.repeat(size - 1)}`
				w.source.changedFiles = [
					changed('a.ts', patch(10)),
					changed('big.ts', patch(32 * 1024 + 1)),
					changed('image.png', null),
					...Array.from({ length: 8 }, (_, index) => changed(`f${index}.ts`, patch(32 * 1024))),
				]
				const diff = await getWorkspaceDiffUseCase(w.context(author), { workspaceId: created.id, includePatches: true })
				expect(diff.files.map((file) => file.patch?.length ?? null)).toEqual([10, null, null, ...Array(7).fill(32 * 1024), null])
				expect(diff.incomplete).toEqual([
					'no patch for big.ts, image.png, f7.ts: GitHub gave none (binary or very large), it is over 32 KiB, or the patches '
					+ 'reached 256 KiB together; read the file, or ask for fewer paths',
				])
				const narrowed = await getWorkspaceDiffUseCase(w.context(author), { workspaceId: created.id, includePatches: true, paths: ['f7.ts'] })
				expect(narrowed.files.filter((file) => file.patch !== undefined)).toEqual([changed('f7.ts', patch(32 * 1024))])
				expect(narrowed.incomplete).toEqual([])
			})

			test('a diff needs read access to the caller own workspace', async () => {
				const w = await world()
				const created = await workspace(w)
				const stranger = oauthUser(AUTHOR_ACTIONS, 'stranger@acme.test')
				const writerOnly = oauthUser(['source.workspace.write'], 'author@acme.test')
				for (const auth of [stranger, writerOnly]) {
					await expect(getWorkspaceDiffUseCase(w.context(auth), { workspaceId: created.id, includePatches: true })).rejects.toMatchObject({
						httpStatus: 404,
					})
				}
				expect(w.source.kinds()).toEqual(['read-branch', 'create-branch'])
			})
		})

		describe('search', () => {
			test('a glob alone lists the matching file paths of the tree', async () => {
				const w = await world()
				const created = await workspace(w)
				for (const path of ['README.md', 'src/a.ts', 'src/lib/b.ts']) w.source.contents.set(path, '')
				const found = await searchFilesUseCase(w.context(author), { workspaceId: created.id, glob: 'src/**/*.ts', maxResults: 10 })
				expect(found).toEqual({ commitSha: sha('a'), paths: ['src/a.ts', 'src/lib/b.ts'], matches: [], incomplete: [] })
				const capped = await searchFilesUseCase(w.context(author), { workspaceId: created.id, glob: '**', maxResults: 1 })
				expect(capped).toEqual({ commitSha: sha('a'), paths: ['README.md'], matches: [], incomplete: ['3 paths matched; only the first 1 are listed'] })
				expect(w.source.calls.at(-1)).toEqual({ kind: 'list-tree', commitSha: sha('a') })
			})

			test('a text search returns the matching lines of the admitted files, literally', async () => {
				const w = await world()
				const created = await workspace(w)
				w.source.contents.set('src/a.ts', 'const Title = 1\nconst title = (x)\n')
				w.source.contents.set('src/b.md', 'Title (x)')
				w.source.contents.set('docs/c.ts', 'title')
				const search = (input: Partial<Parameters<typeof searchFilesUseCase>[1]>) =>
					searchFilesUseCase(w.context(author), { workspaceId: created.id, maxResults: 50, ...input })
				expect((await search({ text: 'title', glob: 'src/**/*.ts' })).matches).toEqual([{ path: 'src/a.ts', line: 2, text: 'const title = (x)' }])
				expect((await search({ text: 'TITLE', caseSensitive: false, directory: 'src' })).matches.map((match) => match.path)).toEqual([
					'src/a.ts',
					'src/a.ts',
					'src/b.md',
				])
				expect((await search({ text: '(x)', glob: '*.ts' })).matches).toEqual([])
				expect((await search({ text: '(x)' })).matches.map((match) => match.path)).toEqual(['src/a.ts', 'src/b.md'])
				expect(w.source.calls.at(-1)).toEqual({ kind: 'scan-files', commitSha: sha('a'), maxFiles: SEARCH_MAX_FILES })
			})

			test('each bound that cuts the answer short is named, and a long line is cut around the match', async () => {
				const w = await world()
				const created = await workspace(w)
				for (let index = 0; index < SEARCH_MAX_FILES + 1; index++) w.source.contents.set(`f${String(index).padStart(3, '0')}.txt`, 'hit\nhit')
				w.source.unreadable.set('f000.txt', 'too_large')
				w.source.unreadable.set('f001.txt', 'budget')
				w.source.contents.set('a-long.txt', `${'x'.repeat(500)}needle${'y'.repeat(500)}`)
				const long = await searchFilesUseCase(w.context(author), { workspaceId: created.id, text: 'needle', maxResults: 5 })
				expect(long.matches[0]?.text).toHaveLength(240)
				expect(long.matches[0]?.text).toContain('needle')
				const capped = await searchFilesUseCase(w.context(author), { workspaceId: created.id, text: 'hit', maxResults: 5 })
				expect(capped.matches).toHaveLength(5)
				expect(capped.incomplete).toEqual([
					`only the first ${SEARCH_MAX_FILES} of ${SEARCH_MAX_FILES + 2} files were searched; narrow the glob or the directory`,
					'1 files were not searched: they are over 512 KiB',
					'1 files were not searched: the files searched reached 2 MiB together; narrow the glob or the directory',
					'matches stop at maxResults (5)',
				])
			})

			test('a search needs a glob or a text and read access to the workspace', async () => {
				const w = await world()
				const created = await workspace(w)
				await expect(searchFilesUseCase(w.context(author), { workspaceId: created.id, maxResults: 5 })).rejects.toMatchObject({ httpStatus: 400 })
				const writerOnly = oauthUser(['source.workspace.write'], 'author@acme.test')
				await expect(searchFilesUseCase(w.context(writerOnly), { workspaceId: created.id, text: 'x', maxResults: 5 })).rejects.toMatchObject({
					httpStatus: 404,
				})
				expect(w.source.kinds()).toEqual(['read-branch', 'create-branch'])
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

			test('an edit replaces the one occurrence of oldString in the file at the expected head, in order per path', async () => {
				const w = await world()
				const created = await workspace(w)
				w.source.contents.set('src/a.ts', 'const a = 1\nconst b = 2\n')
				await applyChangesUseCase(w.context(author), {
					workspaceId: created.id,
					expectedHeadSha: sha('a'),
					message: 'Edit',
					changes: [
						{ path: 'src/a.ts', oldString: 'a = 1', newString: 'a = $& 10' },
						{ path: 'notes.md', content: 'new' },
						{ path: 'src/a.ts', oldString: 'a = $& 10\nconst b', newString: 'a = 10\nlet b' },
					],
				})
				expect(w.source.calls.slice(-2)).toEqual([
					{ kind: 'read-files', commitSha: sha('a'), paths: ['src/a.ts'] },
					expect.objectContaining({
						kind: 'commit',
						commit: expect.objectContaining({
							expectedHeadSha: sha('a'),
							changes: [{ path: 'src/a.ts', content: 'const a = 10\nlet b = 2\n' }, { path: 'notes.md', content: 'new' }],
						}),
					}),
				])
			})

			test('an edit is refused unless oldString occurs exactly once in a readable file, before anything is committed', async () => {
				const w = await world()
				const created = await workspace(w)
				w.source.contents.set('src/a.ts', 'let x = 1\nlet x = 1\naaa\n')
				w.source.unreadable.set('gone.ts', 'missing')
				w.source.unreadable.set('big.ts', 'budget')
				const edit = (path: string, oldString: string) =>
					applyChangesUseCase(w.context(author), {
						workspaceId: created.id,
						expectedHeadSha: sha('a'),
						message: 'm',
						changes: [{ path, oldString, newString: 'y' }],
					})
				await expect(edit('src/a.ts', 'absent')).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('does not occur') })
				await expect(edit('src/a.ts', 'let x = 1')).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('more than once') })
				await expect(edit('src/a.ts', 'aa')).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('more than once') })
				await expect(edit('gone.ts', 'x')).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('does not exist') })
				await expect(edit('big.ts', 'x')).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('split the edits') })
				w.source.contents.set('src/a.ts', 'x')
				expect(w.source.kinds()).not.toContain('commit')
				expect((await edit('src/a.ts', 'x')).commitSha).toBe(sha('1'))
			})

			test('an edit of a protected path, a path also written whole, or an oversized result is refused', async () => {
				const w = await world()
				const created = await workspace(w)
				const apply = (changes: Parameters<typeof applyChangesUseCase>[1]['changes']) =>
					applyChangesUseCase(w.context(author), { workspaceId: created.id, expectedHeadSha: sha('a'), message: 'm', changes })
				await expect(apply([{ path: 'fabrika.config.ts', oldString: 'a', newString: 'b' }])).rejects.toMatchObject({ httpStatus: 403 })
				await expect(apply([{ path: 'src/a.ts', content: 'x' }, { path: 'src/a.ts', oldString: 'x', newString: 'y' }])).rejects
					.toMatchObject({ httpStatus: 400 })
				await expect(apply([{ path: 'src/a.ts', oldString: 'x', newString: 'y' }, { path: 'src/a.ts', content: 'x' }])).rejects
					.toMatchObject({ httpStatus: 400 })
				expect(w.source.kinds()).toEqual(['read-branch', 'create-branch'])
				w.source.contents.set('src/a.ts', 'x')
				await expect(apply([{ path: 'src/a.ts', oldString: 'x', newString: 'y'.repeat(512 * 1024 + 1) }])).rejects.toMatchObject({
					httpStatus: 400,
				})
				expect(w.source.kinds()).not.toContain('commit')
			})

			test('an edit against a stale head fails with the new head', async () => {
				const w = await world()
				const created = await workspace(w)
				w.source.contents.set('src/a.ts', 'x')
				w.source.branches.set(created.branch, sha('e'))
				await expect(applyChangesUseCase(w.context(author), {
					workspaceId: created.id,
					expectedHeadSha: sha('a'),
					message: 'm',
					changes: [{ path: 'src/a.ts', oldString: 'x', newString: 'y' }],
				})).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining(sha('e')) })
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
				expect(await getDeploymentUseCase(w.context(author), { runId: run.id, log: TAIL })).toEqual({
					run,
					finished: false,
					summary: 'Queued and not started yet; poll again.',
					log: { lines: [{ ts: 1, stream: 'meta', text: 'building' }], from: 0, to: 1, total: 1 },
					approval: null,
					deviations: [],
				})
				await expect(getDeploymentUseCase(w.context(oauthUser(['source.workspace.read'])), { runId: run.id, log: TAIL })).rejects.toMatchObject({
					httpStatus: 404,
				})
			})

			test('a finished run says so and what its status means', async () => {
				const w = await world()
				const created = await workspace(w)
				const runs = fixtureRuns(w.repositories.runs, new SqlDeployLocks(requireOpened().db))
				const succeeded = await deployStageUseCase(w.context(author), { workspaceId: created.id })
				await runs.start(succeeded.id)
				await runs.finish(succeeded.id, 'succeeded')
				expect(await getDeploymentUseCase(w.context(author), { runId: succeeded.id, log: TAIL })).toMatchObject({
					finished: true,
					summary: `Succeeded: the stage environment runs ${sha('a')}.`,
				})
				const failed = await deployStageUseCase(w.context(author), { workspaceId: created.id })
				await runs.start(failed.id)
				await runs.finish(failed.id, 'failed')
				expect(await getDeploymentUseCase(w.context(author), { runId: failed.id, log: TAIL })).toMatchObject({
					finished: true,
					summary: 'Failed; read the log with failuresOnly for the lines that name the failure.',
				})
			})

			test('the log is a bounded window: a tail by default, after for polling, before for paging back, failures only on request', async () => {
				const w = await world()
				const created = await workspace(w)
				const run = await deployStageUseCase(w.context(author), { workspaceId: created.id })
				const lines = Array.from({ length: 10 }, (_, index): RunLogLine => ({ ts: index, stream: 'stdout', text: `step ${index}` }))
				lines[3] = { ts: 3, stream: 'stderr', text: 'npm warn deprecated' }
				lines[6] = { ts: 6, stream: 'stdout', text: 'Error: build failed' }
				lines[7] = { ts: 7, stream: 'stdout', text: 'terrorist is not a failure word, failure is' }
				w.logs.set(`runs/${run.id}/logs.ndjson`, lines)
				const log = async (query: Partial<DeploymentLogQuery>) =>
					(await getDeploymentUseCase(w.context(author), { runId: run.id, log: { lines: 3, failuresOnly: false, ...query } })).log
				expect(await log({})).toEqual({ lines: lines.slice(7), from: 7, to: 10, total: 10 })
				expect(await log({ before: 7 })).toEqual({ lines: lines.slice(4, 7), from: 4, to: 7, total: 10 })
				expect(await log({ after: 8 })).toEqual({ lines: lines.slice(8), from: 8, to: 10, total: 10 })
				expect(await log({ after: 10 })).toEqual({ lines: [], from: 10, to: 10, total: 10 })
				expect(await log({ lines: 0 })).toEqual({ lines: [], from: 10, to: 10, total: 10 })
				expect(await log({ failuresOnly: true, lines: 10 })).toEqual({ lines: [lines[3], lines[6], lines[7]], from: 0, to: 3, total: 3 })
				await expect(log({ after: 1, before: 2 })).rejects.toMatchObject({ httpStatus: 400 })
			})

			test('a run parked for approval is reported with the approval link, the change and its deviations, which no MCP token can approve', async () => {
				const w = await world()
				const created = await workspace(w)
				const run = await deployStageUseCase(w.context(author), { workspaceId: created.id })
				const classification = {
					outcome: 'widening',
					changes: [
						{ effect: 'widens', line: 'Role `editor` gains `notes.delete`' },
						{ effect: 'widens', line: 'Endpoint `api.notes.export` declares raw SQL (`read`)', review: 'closer' },
					],
					candidateDigest: `sha256:${'a'.repeat(64)}`,
					baselineDigest: `sha256:${'b'.repeat(64)}`,
					baselineRunId: null,
					protected: true,
				}
				const owned = fixtureRuns(w.repositories.runs, new SqlDeployLocks(requireOpened().db))
				await owned.start(run.id, `runs/${run.id}/logs.ndjson`)
				await owned.park(run.id, JSON.stringify(classification))

				const deployment = await getDeploymentUseCase(w.context(author), { runId: run.id, log: TAIL })
				expect(deployment.run.status).toBe('awaiting_approval')
				expect(deployment.finished).toBe(false)
				expect(deployment.summary).toStartWith('Waiting for a person to approve')
				expect(deployment.approval).toEqual({
					url: `https://console.example.test/approvals/${run.id}`,
					changes: ['Role `editor` gains `notes.delete`', 'Endpoint `api.notes.export` declares raw SQL (`read`)'],
				})
				expect(deployment.deviations).toEqual(['Endpoint `api.notes.export` declares raw SQL (`read`)'])
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
					await expect(getDeploymentUseCase(w.context(author), { runId, log: TAIL })).rejects.toMatchObject({ httpStatus: 404 })
				}
				expect((await getDeploymentUseCase(w.context(author), { runId: own.id, log: TAIL })).run.id).toBe(own.id)
				await putAppEnvUseCase(registryContext(w.repositories), 'shop', 'stage', { ...zeropsEnvelopes(), authoring: false })
				await expect(getDeploymentUseCase(w.context(author), { runId: own.id, log: TAIL })).rejects.toMatchObject({ httpStatus: 404 })
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
