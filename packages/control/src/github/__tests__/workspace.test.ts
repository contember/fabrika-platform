import {
	type GitHubBlobRead,
	type GitHubBlobRef,
	GitHubBranchConflictError,
	type GitHubFileRead,
	GitHubNotFoundError,
	type GitHubRepositoryClient,
	type GitHubRepositoryOpenRequest,
	GitHubStaleHeadError,
	type GitHubTreeEntry,
} from '@fabrika/github-app'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHarness } from '../../__tests__/helpers/harness'
import type { Env } from '../../env'
import { Vault } from '../../vault'
import { WorkspaceSourceError, type WorkspaceSourceErrorKind, type WorkspaceSourceTarget } from '../../workspace-source-port'
import { encodeGitHubAppCredential, type GitHubAppCredential } from '../connections/credentials'
import { githubAppCredentialSecretLabel } from '../connections/secrets'
import { githubWorkspaceSource, WORKSPACE_MAX_SCAN_FILES, WORKSPACE_MAX_TREE_ENTRIES } from '../workspace'

const headSha = 'a'.repeat(40)
const nextSha = 'b'.repeat(40)
const secretText = 'ghs_installationTokenThatMustNeverLeak https://x-access-token:ghs_secret@github.com'
const target: WorkspaceSourceTarget = { connectionId: 'alpha', installationId: 11, owner: 'acme', repository: 'shop' }

function testKey(): string {
	let binary = ''
	for (let index = 0; index < 32; index++) binary += String.fromCharCode(index + 1)
	return btoa(binary)
}

class FakeRepository implements GitHubRepositoryClient {
	readonly calls: { method: keyof GitHubRepositoryClient; args: unknown[] }[] = []
	failure: Error | undefined
	treeEntries: readonly GitHubTreeEntry[] = []

	async readRef(branch: string) {
		this.record('readRef', [branch])
		return branch === 'fabrika/missing' ? null : { branch, sha: headSha }
	}

	async readTree(commitSha: string, directory?: string) {
		this.record('readTree', [commitSha, directory])
		return { commitSha, directory: directory ?? '', entries: this.treeEntries, truncated: false }
	}

	async readFiles(commitSha: string, paths: readonly string[]): Promise<GitHubFileRead> {
		this.record('readFiles', [commitSha, paths])
		return {
			commitSha,
			files: [{ path: 'src/b.ts', content: 'b' }, { path: 'src/a.ts', content: '' }],
			unreadable: [{ path: 'src/gone.ts', reason: 'missing' }, { path: 'src/big.ts', reason: 'too_large' }],
		}
	}

	async readBlobTexts(blobs: readonly GitHubBlobRef[]): Promise<GitHubBlobRead> {
		this.record('readBlobTexts', [blobs])
		return {
			files: blobs.filter((blob) => blob.path !== 'src/big.ts').map((blob) => ({ path: blob.path, content: `text of ${blob.path}` })),
			unreadable: blobs.filter((blob) => blob.path === 'src/big.ts').map((blob) => ({ path: blob.path, reason: 'too_large' })),
		}
	}

	async createBranch(input: Parameters<GitHubRepositoryClient['createBranch']>[0]) {
		this.record('createBranch', [{ branch: input.branch, fromSha: input.fromSha }])
		return { branch: input.branch, sha: input.fromSha }
	}

	async commitFiles(input: Parameters<GitHubRepositoryClient['commitFiles']>[0]) {
		const { signal: _signal, ...rest } = input
		this.record('commitFiles', [rest])
		return { sha: nextSha, treeSha: 'c'.repeat(40), parents: [input.expectedHeadSha] }
	}

	async openPullRequest(input: Parameters<GitHubRepositoryClient['openPullRequest']>[0]) {
		const { signal: _signal, ...rest } = input
		this.record('openPullRequest', [rest])
		return { number: 7, url: 'https://github.com/acme/shop/pull/7', created: true }
	}

	private record(method: keyof GitHubRepositoryClient, args: unknown[]): void {
		this.calls.push({ method, args })
		if (this.failure !== undefined) throw this.failure
	}
}

/** One connection `alpha` for the `acme` organization, its App key sealed in the vault under its own purpose. */
async function fixture() {
	const harness = createHarness()
	const env: Env = {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response()) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'test',
		FABRIKA_CONTROL_VAULT_KEY: testKey(),
	}
	const vault = await Vault.create(harness.d1, testKey())
	const credentialRef = await vault.putSecret(
		'platform',
		githubAppCredentialSecretLabel('alpha'),
		encodeGitHubAppCredential({ appId: '1001', privateKeyPem: 'alpha-key' }),
	)
	harness.sqlite.query(`INSERT INTO github_source_connections_keyed (
		connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES ('alpha', '1001', 'alpha-app', 'https://github.com/apps/alpha-app', 'acme', 'alpha-app', 0, ?,
		'https://control.test/webhooks/github/alpha', 'vault:alpha-webhook', 11, 'acme', 'all', '[]', '[]', 'test', 1, 1, 1)`)
		.run(credentialRef)

	const repository = new FakeRepository()
	const credentials: GitHubAppCredential[] = []
	const opened: GitHubRepositoryOpenRequest[] = []
	const openFailure: { error: Error | undefined } = { error: undefined }
	const source = githubWorkspaceSource(env, async (credential) => {
		credentials.push(credential)
		return {
			openRepository: async (input) => {
				opened.push(input)
				if (openFailure.error !== undefined) throw openFailure.error
				return repository
			},
		}
	})
	return { source, repository, credentials, opened, openFailure }
}

const signal = (): AbortSignal => new AbortController().signal

async function failureKind(operation: Promise<unknown>): Promise<WorkspaceSourceErrorKind> {
	try {
		await operation
	} catch (error) {
		if (error instanceof WorkspaceSourceError) return error.kind
		throw error
	}
	throw new Error('expected a workspace failure')
}

describe('GitHub workspace source', () => {
	let errorLog: ReturnType<typeof spyOn<Console, 'error'>>
	beforeEach(() => {
		errorLog = spyOn(console, 'error').mockImplementation(() => {})
	})
	afterEach(() => {
		errorLog.mockRestore()
	})

	test("opens the binding's repository with that connection's vault key and reads a branch", async () => {
		const { source, credentials, opened } = await fixture()
		expect(await source.readBranch({ target, branch: 'main', signal: signal() })).toBe(headSha)
		expect(await source.readBranch({ target, branch: 'fabrika/missing', signal: signal() })).toBeNull()
		expect(credentials).toEqual([{ appId: '1001', privateKeyPem: 'alpha-key' }, { appId: '1001', privateKeyPem: 'alpha-key' }])
		expect(opened.map(({ signal: _signal, ...input }) => input)).toEqual([
			{ installationId: 11, owner: 'acme', repository: 'shop' },
			{ installationId: 11, owner: 'acme', repository: 'shop' },
		])
	})

	test('refuses a binding that does not own the repository before any GitHub client exists', async () => {
		const { source, credentials } = await fixture()
		expect(await failureKind(source.readBranch({ target: { ...target, owner: 'other-org' }, branch: 'main', signal: signal() }))).toBe('unavailable')
		expect(await failureKind(source.readBranch({ target: { ...target, installationId: 99 }, branch: 'main', signal: signal() }))).toBe('unavailable')
		expect(credentials).toEqual([])
	})

	test('creates a branch, commits, and opens a pull request', async () => {
		const { source, repository } = await fixture()
		expect(await source.createBranch({ target, branch: 'fabrika/ws-1', fromSha: headSha, signal: signal() })).toBe(headSha)
		const author = { name: 'Ada', email: 'p1@users.noreply.fabrika' }
		const changes = [{ path: 'src/a.ts', content: 'a' }, { path: 'old.ts', content: null }]
		expect(await source.commit({ target, branch: 'fabrika/ws-1', expectedHeadSha: headSha, message: 'm', author, changes, signal: signal() }))
			.toBe(nextSha)
		expect(await source.openPullRequest({ target, head: 'fabrika/ws-1', base: 'main', title: 't', body: 'b', signal: signal() }))
			.toEqual({ number: 7, url: 'https://github.com/acme/shop/pull/7', created: true })
		expect(repository.calls).toEqual([
			{ method: 'createBranch', args: [{ branch: 'fabrika/ws-1', fromSha: headSha }] },
			{ method: 'commitFiles', args: [{ branch: 'fabrika/ws-1', expectedHeadSha: headSha, message: 'm', author, changes }] },
			{ method: 'openPullRequest', args: [{ head: 'fabrika/ws-1', base: 'main', title: 't', body: 'b' }] },
		])
	})

	test('lists a tree, classifying entries by git mode', async () => {
		const { source, repository } = await fixture()
		repository.treeEntries = [
			{ path: 'src', sha: 'd'.repeat(40), type: 'tree', mode: '040000' },
			{ path: 'src/a.ts', sha: 'd'.repeat(40), type: 'blob', mode: '100644', size: 12 },
			{ path: 'bin/run', sha: 'd'.repeat(40), type: 'blob', mode: '100755', size: 3 },
			{ path: 'link', sha: 'd'.repeat(40), type: 'blob', mode: '120000', size: 5 },
			{ path: 'vendor/lib', sha: 'd'.repeat(40), type: 'commit', mode: '160000' },
		]
		expect(await source.listTree({ target, commitSha: headSha, directory: 'src', signal: signal() })).toEqual({
			commitSha: headSha,
			entries: [
				{ path: 'src', kind: 'directory' },
				{ path: 'src/a.ts', kind: 'file', size: 12 },
				{ path: 'bin/run', kind: 'file', size: 3 },
				{ path: 'link', kind: 'other' },
				{ path: 'vendor/lib', kind: 'other' },
			],
			truncated: false,
		})
		expect(repository.calls).toEqual([{ method: 'readTree', args: [headSha, 'src'] }])
	})

	test('caps a tree listing and marks it truncated', async () => {
		const { source, repository } = await fixture()
		repository.treeEntries = Array.from(
			{ length: WORKSPACE_MAX_TREE_ENTRIES + 1 },
			(_, index): GitHubTreeEntry => ({ path: `f${index}`, sha: 'd'.repeat(40), type: 'blob', mode: '100644', size: 1 }),
		)
		const listing = await source.listTree({ target, commitSha: headSha, signal: signal() })
		expect(listing.entries).toHaveLength(WORKSPACE_MAX_TREE_ENTRIES)
		expect(listing.truncated).toBe(true)
	})

	test('reads files in request order, an unread path as null with its reason', async () => {
		const { source } = await fixture()
		const paths = ['src/a.ts', 'src/gone.ts', 'src/b.ts', 'src/big.ts']
		expect(await source.readFiles({ target, commitSha: headSha, paths, signal: signal() })).toEqual({
			commitSha: headSha,
			files: [
				{ path: 'src/a.ts', content: '' },
				{ path: 'src/gone.ts', content: null, reason: 'missing' },
				{ path: 'src/b.ts', content: 'b' },
				{ path: 'src/big.ts', content: null, reason: 'too_large' },
			],
		})
	})

	test('scans the admitted regular files of a tree listing, at most the bound, and counts the rest', async () => {
		const { source, repository } = await fixture()
		const blob = (path: string, mode: '100644' | '120000' = '100644'): GitHubTreeEntry => ({ path, sha: 'd'.repeat(40), type: 'blob', mode, size: 3 })
		repository.treeEntries = [
			{ path: 'src', sha: 'e'.repeat(40), type: 'tree', mode: '040000' },
			blob('src/a.ts'),
			blob('src/big.ts'),
			blob('src/link.ts', '120000'),
			blob('src/c.md'),
			...Array.from({ length: WORKSPACE_MAX_SCAN_FILES }, (_, index) => blob(`src/gen/f${index}.ts`)),
		]
		const scan = await source.scanFiles({
			target,
			commitSha: headSha,
			directory: 'src',
			include: (path) => path.endsWith('.ts'),
			maxFiles: 500,
			signal: signal(),
		})
		expect(scan.candidates).toBe(WORKSPACE_MAX_SCAN_FILES + 2)
		expect(scan.files).toHaveLength(WORKSPACE_MAX_SCAN_FILES)
		expect(scan.files.slice(0, 2)).toEqual([{ path: 'src/a.ts', content: 'text of src/a.ts' }, {
			path: 'src/big.ts',
			content: null,
			reason: 'too_large',
		}])
		expect(scan.treeTruncated).toBe(false)
		expect(repository.calls.map((call) => call.method)).toEqual(['readTree', 'readBlobTexts'])

		const none = await source.scanFiles({ target, commitSha: headSha, include: () => false, maxFiles: 10, signal: signal() })
		expect(none).toEqual({ commitSha: headSha, files: [], candidates: 0, treeTruncated: false })
		expect(repository.calls.map((call) => call.method)).toEqual(['readTree', 'readBlobTexts', 'readTree'])
	})

	const classified: [Error, WorkspaceSourceErrorKind][] = [
		[new GitHubStaleHeadError(), 'stale_head'],
		[new GitHubBranchConflictError(), 'conflict'],
		[new GitHubNotFoundError(), 'not_found'],
	]
	test.each(classified)('classifies %p', async (error, kind) => {
		const { source, repository } = await fixture()
		repository.failure = error
		expect(await failureKind(source.readBranch({ target, branch: 'main', signal: signal() }))).toBe(kind)
	})

	test('never echoes GitHub error text when an operation or the repository open fails', async () => {
		const { source, repository, openFailure } = await fixture()
		repository.failure = new Error(secretText)
		const operation = source.readFiles({ target, commitSha: headSha, paths: ['a.txt'], signal: signal() })
		await expect(operation).rejects.toThrow(WorkspaceSourceError)
		await expect(operation).rejects.not.toThrow(/ghs_/)
		openFailure.error = new Error(secretText)
		expect(await failureKind(source.readBranch({ target, branch: 'main', signal: signal() }))).toBe('unavailable')
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain('ghs_')
	})
})
