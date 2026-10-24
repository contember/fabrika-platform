import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import {
	GitHubAppClient,
	type GitHubAppFetch,
	GitHubBranchConflictError,
	GitHubNotFoundError,
	type GitHubRepositoryClient,
	GitHubStaleHeadError,
} from '..'

const NOW = Date.UTC(2026, 7, 11, 10, 20, 30)
const EXPIRES_AT = '2026-08-11T11:20:30.000Z'
const SECRET_TOKEN = 'ghs_private-write-token'
const API = 'https://github.example/api/v3'
const REPO = `${API}/repos/contember/fabrika`

const PRIVATE_KEY = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey

const sha = (seed: string): string => seed.repeat(40).slice(0, 40)
const HEAD = sha('a')
const OTHER = sha('b')
const ROOT_TREE = sha('c')
const SRC_TREE = sha('d')
const NEW_TREE = sha('e')
const NEW_COMMIT = sha('f')
const BLOB_TEXT = sha('1')
const BLOB_BINARY = sha('2')
const BLOB_LARGE = sha('3')
const BLOB_LINK = sha('4')

interface Recorded {
	readonly method: string
	readonly url: string
	readonly authorization: string | null
	readonly body: unknown
}

type Route = (request: Recorded) => Response | undefined

function fakeGitHub(routes: Route[]): { fetch: GitHubAppFetch; requests: Recorded[] } {
	const requests: Recorded[] = []
	return {
		requests,
		fetch: (input, init) => {
			const headers = new Headers(init?.headers)
			const rawBody = init?.body
			const body: unknown = typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined
			const request = { method: init?.method ?? 'GET', url: input.toString(), authorization: headers.get('authorization'), body }
			requests.push(request)
			if (request.url === `${API}/app/installations/77/access_tokens`) {
				return Promise.resolve(Response.json({ token: SECRET_TOKEN, expires_at: EXPIRES_AT }, { status: 201 }))
			}
			for (const route of routes) {
				const response = route(request)
				if (response !== undefined) return Promise.resolve(response)
			}
			return Promise.resolve(Response.json({ message: 'Not Found' }, { status: 404 }))
		},
	}
}

const on = (method: string, path: string, respond: (request: Recorded) => Response): Route => (request) =>
	request.method === method && request.url === `${REPO}${path}` ? respond(request) : undefined

const json = (body: unknown, status = 200) => () => Response.json(body, { status })

const ref = (branch: string, target: string) => ({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: target } })
const commit = (commitSha: string, treeSha: string, parents: string[]) => ({
	sha: commitSha,
	tree: { sha: treeSha },
	parents: parents.map((parent) => ({ sha: parent })),
})
const blobEntry = (path: string, blobSha: string, size: number, mode = '100644') => ({ path, mode, type: 'blob', sha: blobSha, size })
const treeEntry = (path: string, treeSha: string) => ({ path, mode: '040000', type: 'tree', sha: treeSha })
const blob = (blobSha: string, bytes: Uint8Array) => ({
	sha: blobSha,
	size: bytes.byteLength,
	encoding: 'base64',
	content: btoa(String.fromCharCode(...bytes)),
})

/** A tree as the client reads it: `<commit>:<directory>` at the head. */
const at = (directory: string): string => `/git/trees/${encodeURIComponent(`${HEAD}:${directory}`)}`

const HEAD_COMMIT_ROUTE = on('GET', `/git/commits/${HEAD}`, json(commit(HEAD, ROOT_TREE, [OTHER])))

async function open(routes: Route[]): Promise<{ repository: GitHubRepositoryClient; requests: Recorded[] }> {
	const github = fakeGitHub(routes)
	const app = await GitHubAppClient.create({ appId: '123456', privateKeyPem: PRIVATE_KEY, apiBaseUrl: API, fetch: github.fetch, now: () => NOW })
	const repository = await app.openRepository({ installationId: 77, owner: 'contember', repository: 'fabrika' })
	return { repository, requests: github.requests }
}

async function errorOf(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error))
	}
	throw new Error('expected operation to fail')
}

const repositoryRequests = (requests: Recorded[]) => requests.filter((request) => request.url.startsWith(REPO))

describe('GitHubAppClient.openRepository', () => {
	test('mints a write token restricted to exactly the one repository and uses it only for that repository', async () => {
		const { repository, requests } = await open([on('GET', '/git/ref/heads/feature/x', json(ref('feature/x', HEAD)))])
		expect(await repository.readRef('feature/x')).toEqual({ branch: 'feature/x', sha: HEAD })
		expect(requests[0]?.body).toEqual({ repositories: ['fabrika'], permissions: { contents: 'write', pull_requests: 'write' } })
		expect(requests[0]?.authorization).not.toContain(SECRET_TOKEN)
		expect(requests[1]?.authorization).toBe(`Bearer ${SECRET_TOKEN}`)
		expect(JSON.stringify(repository)).not.toContain(SECRET_TOKEN)
		const reachable = Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).sort()
		expect(reachable).toEqual([
			'commitFiles',
			'compareCommits',
			'constructor',
			'createBranch',
			'deleteBranch',
			'openPullRequest',
			'readBlobTexts',
			'readFiles',
			'readRef',
			'readTree',
		])
		expect(Object.keys(repository)).toEqual([])
	})

	test('reads a missing branch as null', async () => {
		const { repository } = await open([])
		expect(await repository.readRef('missing')).toBeNull()
	})
})

describe('readTree', () => {
	test('lists a directory recursively with repository-relative paths', async () => {
		const { repository, requests } = await open([
			on(
				'GET',
				`${at('src')}?recursive=1`,
				json({ sha: SRC_TREE, truncated: false, tree: [blobEntry('index.ts', BLOB_TEXT, 5), treeEntry('lib', NEW_TREE)] }),
			),
		])
		expect(await repository.readTree(HEAD, 'src')).toEqual({
			commitSha: HEAD,
			directory: 'src',
			entries: [{ path: 'src/index.ts', mode: '100644', type: 'blob', sha: BLOB_TEXT, size: 5 }, {
				path: 'src/lib',
				mode: '040000',
				type: 'tree',
				sha: NEW_TREE,
			}],
			truncated: false,
		})
		// One request: GitHub resolves `<commit>:<directory>` itself.
		expect(repositoryRequests(requests).map((request) => request.method)).toEqual(['GET'])
	})

	test('caps the listing and reports truncation, including GitHub-side truncation', async () => {
		const many = Array.from({ length: 5001 }, (_, index) => blobEntry(`f${index}`, BLOB_TEXT, 1))
		const capped = await open([
			HEAD_COMMIT_ROUTE,
			on('GET', `${at('')}?recursive=1`, json({ sha: ROOT_TREE, truncated: false, tree: many })),
		])
		const listing = await capped.repository.readTree(HEAD)
		expect(listing.entries).toHaveLength(5000)
		expect(listing.truncated).toBe(true)

		const upstream = await open([
			HEAD_COMMIT_ROUTE,
			on('GET', `${at('')}?recursive=1`, json({ sha: ROOT_TREE, truncated: true, tree: [blobEntry('a', BLOB_TEXT, 1)] })),
		])
		expect((await upstream.repository.readTree(HEAD)).truncated).toBe(true)
	})
})

describe('readFiles', () => {
	const large = 512 * 1024 + 1
	const routes = (): Route[] => [
		HEAD_COMMIT_ROUTE,
		on(
			'GET',
			at(''),
			json({
				sha: ROOT_TREE,
				truncated: false,
				tree: [
					treeEntry('src', SRC_TREE),
					blobEntry('image.png', BLOB_BINARY, 2),
					blobEntry('large.txt', BLOB_LARGE, large),
					blobEntry('link', BLOB_LINK, 4, '120000'),
				],
			}),
		),
		on('GET', at('src'), json({ sha: SRC_TREE, truncated: false, tree: [blobEntry('index.ts', BLOB_TEXT, 6)] })),
		on('GET', `/git/blobs/${BLOB_TEXT}`, json(blob(BLOB_TEXT, new TextEncoder().encode('héllo')))),
		on('GET', `/git/blobs/${BLOB_BINARY}`, json(blob(BLOB_BINARY, new Uint8Array([0xff, 0xfe])))),
	]

	test('returns UTF-8 regular files and says why each other path was not read', async () => {
		const { repository, requests } = await open(routes())
		const read = await repository.readFiles(HEAD, ['src/index.ts', 'src/absent.ts', 'image.png', 'large.txt', 'link', 'src/index.ts/x', 'src'])
		expect(read).toEqual({
			commitSha: HEAD,
			files: [{ path: 'src/index.ts', content: 'héllo' }],
			unreadable: [
				{ path: 'src/absent.ts', reason: 'missing' },
				{ path: 'image.png', reason: 'binary' },
				{ path: 'large.txt', reason: 'too_large' },
				{ path: 'link', reason: 'not_a_file' },
				{ path: 'src/index.ts/x', reason: 'missing' },
				{ path: 'src', reason: 'not_a_file' },
			],
		})
		expect(requests.some((request) => request.url.endsWith(`/git/blobs/${BLOB_LARGE}`))).toBe(false)
		expect(requests.some((request) => request.url.endsWith(`/git/blobs/${BLOB_LINK}`))).toBe(false)
	})

	test('a file past the total read budget is reported as such and never fetched', async () => {
		const size = 512 * 1024
		const names = ['a', 'b', 'c', 'd', 'e']
		const blobSha = (index: number) => sha(String(index + 5))
		const content = new Uint8Array(size).fill(0x61)
		const { repository, requests } = await open([
			HEAD_COMMIT_ROUTE,
			on(
				'GET',
				at(''),
				json({ sha: ROOT_TREE, truncated: false, tree: names.map((name, index) => blobEntry(name, blobSha(index), size)) }),
			),
			...names.map((_, index) => on('GET', `/git/blobs/${blobSha(index)}`, json(blob(blobSha(index), content)))),
		])
		const read = await repository.readFiles(HEAD, names)
		expect(read.files.map((file) => file.path)).toEqual(['a', 'b', 'c', 'd'])
		expect(read.unreadable).toEqual([{ path: 'e', reason: 'budget' }])
		expect(requests.some((request) => request.url.endsWith(`/git/blobs/${blobSha(4)}`))).toBe(false)
	})

	test('refuses unbounded or invalid path lists before any repository request', async () => {
		const { repository, requests } = await open(routes())
		const tooMany = Array.from({ length: 101 }, (_, index) => `f${index}`)
		const deep = Array.from({ length: 65 }, () => 'd').join('/')
		for (const paths of [[], tooMany, ['a', 'a'], ['../etc/passwd'], ['/abs'], ['.git/config'], ['a//b'], [deep]]) {
			await expect(repository.readFiles(HEAD, paths)).rejects.toThrow('GitHub App configuration is invalid')
		}
		expect(repositoryRequests(requests)).toHaveLength(0)
	})
})

describe('readBlobTexts', () => {
	const routes = (): Route[] => [
		on('GET', `/git/blobs/${BLOB_TEXT}`, json(blob(BLOB_TEXT, new TextEncoder().encode('héllo')))),
		on('GET', `/git/blobs/${BLOB_BINARY}`, json(blob(BLOB_BINARY, new Uint8Array([0xff, 0xfe])))),
	]

	test('reads listed blobs without a tree walk and says why each other blob was not read', async () => {
		const size = 512 * 1024
		const { repository, requests } = await open([
			...routes(),
			on('GET', `/git/blobs/${BLOB_LARGE}`, json(blob(BLOB_LARGE, new Uint8Array(size).fill(0x61)))),
		])
		const full = ['a', 'b', 'c'].map((path) => ({ path, sha: BLOB_LARGE, size }))
		const read = await repository.readBlobTexts([
			{ path: 'src/index.ts', sha: BLOB_TEXT, size: 6 },
			{ path: 'large.txt', sha: BLOB_LINK, size: size + 1 },
			{ path: 'image.png', sha: BLOB_BINARY, size: 2 },
			...full,
			{ path: 'last.txt', sha: BLOB_LINK, size },
		])
		expect(read.files.map((file) => file.path)).toEqual(['src/index.ts', 'a', 'b', 'c'])
		expect(read.files[0]).toEqual({ path: 'src/index.ts', content: 'héllo' })
		expect(read.unreadable).toEqual([
			{ path: 'large.txt', reason: 'too_large' },
			{ path: 'image.png', reason: 'binary' },
			{ path: 'last.txt', reason: 'budget' },
		])
		const fetched = repositoryRequests(requests).map((request) => request.url.slice(REPO.length))
		expect(fetched).toHaveLength(5)
		expect(fetched.some((url) => url.endsWith(BLOB_LINK))).toBe(false)
	})

	test('refuses an unbounded or invalid blob list before any repository request', async () => {
		const { repository, requests } = await open(routes())
		const many = Array.from({ length: 101 }, (_, index) => ({ path: `f${index}`, sha: BLOB_TEXT, size: 1 }))
		for (
			const blobs of [
				[],
				many,
				[{ path: 'a', sha: BLOB_TEXT, size: 1 }, { path: 'a', sha: BLOB_BINARY, size: 1 }],
				[{ path: '../a', sha: BLOB_TEXT, size: 1 }],
				[{ path: 'a', sha: 'not-a-sha', size: 1 }],
				[{ path: 'a', sha: BLOB_TEXT, size: -1 }],
			]
		) {
			await expect(repository.readBlobTexts(blobs)).rejects.toThrow('GitHub App configuration is invalid')
		}
		expect(repositoryRequests(requests)).toHaveLength(0)
	})
})

describe('compareCommits', () => {
	test('reads the changed files from the merge base on one page of commits', async () => {
		const { repository, requests } = await open([
			on(
				'GET',
				`/compare/${OTHER}...${HEAD}?per_page=1`,
				json({
					ahead_by: 2,
					behind_by: 0,
					merge_base_commit: { sha: OTHER },
					commits: [{ sha: HEAD }],
					files: [
						{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
						{ filename: 'src/c.ts', previous_filename: 'src/b.ts', status: 'renamed', additions: 0, deletions: 0 },
					],
				}),
			),
		])
		expect(await repository.compareCommits(OTHER, HEAD)).toEqual({
			baseSha: OTHER,
			headSha: HEAD,
			aheadBy: 2,
			behindBy: 0,
			files: [
				{ path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
				{ path: 'src/c.ts', previousPath: 'src/b.ts', status: 'renamed', additions: 0, deletions: 0, patch: null },
			],
			filesCapped: false,
		})
		expect(repositoryRequests(requests)).toHaveLength(1)
	})

	test('an unknown commit is not found, and an invalid sha is refused before any request', async () => {
		const { repository, requests } = await open([])
		await expect(repository.compareCommits(OTHER, HEAD)).rejects.toBeInstanceOf(GitHubNotFoundError)
		await expect(repository.compareCommits('main', HEAD)).rejects.toThrow('GitHub App configuration is invalid')
		expect(repositoryRequests(requests)).toHaveLength(1)
	})
})

describe('deleteBranch', () => {
	test('deletes a branch, and reads an absent one as already deleted', async () => {
		const deleted = await open([on('DELETE', '/git/refs/heads/fabrika/w1', () => new Response(null, { status: 204 }))])
		expect(await deleted.repository.deleteBranch('fabrika/w1')).toEqual({ deleted: true })
		const absent = await open([on('DELETE', '/git/refs/heads/fabrika/w1', json({ message: 'Reference does not exist' }, 422))])
		expect(await absent.repository.deleteBranch('fabrika/w1')).toEqual({ deleted: false })
		expect(absent.requests.map((request) => request.method).slice(-2)).toEqual(['DELETE', 'GET'])
	})

	test('a refusal of a branch that still exists fails, and an invalid branch is refused before any request', async () => {
		const { repository, requests } = await open([
			on('DELETE', '/git/refs/heads/main', json({ message: 'protected' }, 422)),
			on('GET', '/git/ref/heads/main', json(ref('main', HEAD))),
		])
		await expect(repository.deleteBranch('main')).rejects.toThrow('GitHub App request failed with status 422')
		await expect(repository.deleteBranch('a..b')).rejects.toThrow('GitHub App configuration is invalid')
		expect(repositoryRequests(requests)).toHaveLength(2)
	})
})

describe('createBranch', () => {
	test('creates the ref at the requested commit', async () => {
		const { repository, requests } = await open([HEAD_COMMIT_ROUTE, on('POST', '/git/refs', json(ref('work/one', HEAD), 201))])
		expect(await repository.createBranch({ branch: 'work/one', fromSha: HEAD })).toEqual({ branch: 'work/one', sha: HEAD })
		expect(requests.at(-1)?.body).toEqual({ ref: 'refs/heads/work/one', sha: HEAD })
	})

	test('refuses an unknown or non-commit sha without creating a ref', async () => {
		const { repository, requests } = await open([on('GET', `/git/commits/${OTHER}`, json({ message: 'Not Found' }, 404))])
		await expect(repository.createBranch({ branch: 'work/one', fromSha: OTHER })).rejects.toBeInstanceOf(GitHubNotFoundError)
		expect(requests.some((request) => request.method === 'POST' && request.url.startsWith(REPO))).toBe(false)
	})

	test('returns an existing branch already at the commit without writing', async () => {
		const { repository, requests } = await open([on('GET', '/git/ref/heads/work/one', json(ref('work/one', HEAD)))])
		expect(await repository.createBranch({ branch: 'work/one', fromSha: HEAD })).toEqual({ branch: 'work/one', sha: HEAD })
		expect(requests.some((request) => request.method === 'POST' && request.url.startsWith(REPO))).toBe(false)
	})

	test('refuses an existing branch at another commit, also when it appears concurrently', async () => {
		const existing = await open([on('GET', '/git/ref/heads/work/one', json(ref('work/one', OTHER)))])
		await expect(existing.repository.createBranch({ branch: 'work/one', fromSha: HEAD })).rejects.toBeInstanceOf(GitHubBranchConflictError)

		let reads = 0
		const raced = await open([
			HEAD_COMMIT_ROUTE,
			on('GET', '/git/ref/heads/work/one', () => {
				reads += 1
				return reads === 1 ? Response.json({}, { status: 404 }) : Response.json(ref('work/one', OTHER))
			}),
			on('POST', '/git/refs', json({ message: 'Reference already exists' }, 422)),
		])
		await expect(raced.repository.createBranch({ branch: 'work/one', fromSha: HEAD })).rejects.toBeInstanceOf(GitHubBranchConflictError)
	})
})

describe('commitFiles', () => {
	const input = {
		branch: 'work/one',
		expectedHeadSha: HEAD,
		message: 'Edit files',
		author: { name: 'Jane Doe', email: 'jane@example.com' },
		changes: [{ path: 'src/index.ts', content: 'export {}\n' }, { path: 'old.txt', content: null }],
	}

	const writeRoutes = (patch: (request: Recorded) => Response, headAfterPatch = HEAD): Route[] => {
		let patched = false
		return [
			on('PATCH', '/git/refs/heads/work/one', (request) => {
				patched = true
				return patch(request)
			}),
			on('GET', '/git/ref/heads/work/one', () => Response.json(ref('work/one', patched ? headAfterPatch : HEAD))),
			...writeObjectRoutes,
		]
	}

	const writeObjectRoutes: Route[] = [
		HEAD_COMMIT_ROUTE,
		on(
			'GET',
			at(''),
			json({
				sha: ROOT_TREE,
				truncated: false,
				tree: [treeEntry('src', SRC_TREE), blobEntry('run.sh', BLOB_LINK, 4, '100755'), blobEntry('old.txt', BLOB_TEXT, 6)],
			}),
		),
		on('GET', at('src'), json({ sha: SRC_TREE, truncated: false, tree: [blobEntry('index.ts', BLOB_TEXT, 6)] })),
		on('POST', '/git/trees', json({ sha: NEW_TREE, truncated: false, tree: [] }, 201)),
		on('POST', '/git/commits', json(commit(NEW_COMMIT, NEW_TREE, [HEAD]), 201)),
	]

	test('creates one tree on the head tree, one commit with the expected parent, and moves the ref without force', async () => {
		const { repository, requests } = await open(writeRoutes(json(ref('work/one', NEW_COMMIT))))
		expect(await repository.commitFiles(input)).toEqual({ sha: NEW_COMMIT, treeSha: NEW_TREE, parents: [HEAD] })
		const writes = requests.filter((request) => request.method !== 'GET' && request.url.startsWith(REPO))
		expect(writes.map((request) => `${request.method} ${request.url.slice(REPO.length)}`)).toEqual([
			'POST /git/trees',
			'POST /git/commits',
			'PATCH /git/refs/heads/work/one',
		])
		expect(writes[0]?.body).toEqual({
			base_tree: ROOT_TREE,
			tree: [
				{ path: 'src/index.ts', mode: '100644', type: 'blob', content: 'export {}\n' },
				{ path: 'old.txt', mode: '100644', type: 'blob', sha: null },
			],
		})
		const author = { name: 'Jane Doe', email: 'jane@example.com' }
		expect(writes[1]?.body).toEqual({ message: 'Edit files', tree: NEW_TREE, parents: [HEAD], author, committer: author })
		expect(writes[2]?.body).toEqual({ sha: NEW_COMMIT, force: false })
	})

	test('keeps the executable mode of an edited file and creates new files as regular', async () => {
		const { repository, requests } = await open(writeRoutes(json(ref('work/one', NEW_COMMIT))))
		await repository.commitFiles({ ...input, changes: [{ path: 'run.sh', content: 'echo\n' }, { path: 'new.sh', content: 'echo\n' }] })
		const tree = requests.find((request) => request.method === 'POST' && request.url === `${REPO}/git/trees`)
		expect(tree?.body).toEqual({
			base_tree: ROOT_TREE,
			tree: [
				{ path: 'run.sh', mode: '100755', type: 'blob', content: 'echo\n' },
				{ path: 'new.sh', mode: '100644', type: 'blob', content: 'echo\n' },
			],
		})
	})

	test('reads the head commit and the directory of each path once when the same client read files there first', async () => {
		const routes = [
			...writeRoutes(json(ref('work/one', NEW_COMMIT))),
			on('GET', `/git/blobs/${BLOB_TEXT}`, json(blob(BLOB_TEXT, new TextEncoder().encode('index\n')))),
		]
		const { repository, requests } = await open(routes)
		await repository.readFiles(HEAD, ['src/index.ts'])
		await repository.commitFiles(input)
		const objectReads = requests.filter((request) => request.method === 'GET' && /\/git\/(commits|trees)\//.test(request.url))
		expect(objectReads.map((request) => request.url.slice(REPO.length))).toEqual([at('src'), `/git/commits/${HEAD}`, at('')])
	})

	test('refuses a stale head before writing anything', async () => {
		const { repository, requests } = await open([on('GET', '/git/ref/heads/work/one', json(ref('work/one', OTHER)))])
		await expect(repository.commitFiles(input)).rejects.toBeInstanceOf(GitHubStaleHeadError)
		expect(requests.filter((request) => request.method !== 'GET' && request.url.startsWith(REPO))).toHaveLength(0)
	})

	test('maps a refused ref update to a stale head only when the head moved', async () => {
		const moved = await open(writeRoutes(json({ message: 'Update is not a fast forward' }, 422), OTHER))
		await expect(moved.repository.commitFiles(input)).rejects.toBeInstanceOf(GitHubStaleHeadError)

		const protectedBranch = await open(writeRoutes(json({ message: 'Protected branch update failed' }, 422)))
		const error = await errorOf(protectedBranch.repository.commitFiles(input))
		expect(error).not.toBeInstanceOf(GitHubStaleHeadError)
		expect(error.message).toBe('GitHub App request failed with status 422')
	})

	test('deletes only existing files and refuses a missing path or a directory before writing', async () => {
		for (const path of ['missing.txt', 'src']) {
			const { repository, requests } = await open(writeRoutes(json(ref('work/one', NEW_COMMIT))))
			await expect(repository.commitFiles({ ...input, changes: [{ path, content: null }] })).rejects.toThrow('GitHub App configuration is invalid')
			expect(requests.filter((request) => request.method !== 'GET' && request.url.startsWith(REPO))).toHaveLength(0)
		}
	})

	test('reads a head commit whose message is larger than the default response cap', async () => {
		const long = { ...commit(HEAD, ROOT_TREE, [OTHER]), message: 'x'.repeat(200 * 1024) }
		const { repository } = await open([on('GET', `/git/commits/${HEAD}`, json(long)), ...writeRoutes(json(ref('work/one', NEW_COMMIT)))])
		expect(await repository.commitFiles(input)).toEqual({ sha: NEW_COMMIT, treeSha: NEW_TREE, parents: [HEAD] })
	})

	test('validates changes before any repository request', async () => {
		const { repository, requests } = await open([])
		const invalid = [
			{ ...input, changes: [] },
			{ ...input, changes: [{ path: 'a', content: 'x' }, { path: 'a', content: null }] },
			{ ...input, changes: [{ path: 'a', content: 'x' }, { path: 'a/b', content: 'y' }] },
			{ ...input, changes: [{ path: '../a', content: 'x' }] },
			{ ...input, changes: [{ path: '.git/hooks/pre-commit', content: 'x' }] },
			{ ...input, changes: [{ path: Array.from({ length: 65 }, () => 'd').join('/'), content: 'x' }] },
			{ ...input, changes: [{ path: 'a', content: 'x'.repeat(512 * 1024 + 1) }] },
			{ ...input, message: ' ' },
			{ ...input, author: { name: 'Jane', email: 'not-an-email' } },
			{ ...input, expectedHeadSha: 'main' },
		]
		for (const value of invalid) await expect(repository.commitFiles(value)).rejects.toThrow('GitHub App configuration is invalid')
		expect(repositoryRequests(requests)).toHaveLength(0)
	})
})

describe('openPullRequest', () => {
	const input = { head: 'work/one', base: 'main', title: 'Edit files', body: '' }
	const pull = { number: 12, html_url: 'https://github.com/contember/fabrika/pull/12' }

	test('creates the pull request', async () => {
		const { repository, requests } = await open([on('POST', '/pulls', json(pull, 201))])
		expect(await repository.openPullRequest(input)).toEqual({ number: 12, url: pull.html_url, created: true })
		expect(requests.at(-1)?.body).toEqual({ title: 'Edit files', body: '', head: 'work/one', base: 'main' })
	})

	test('accepts pull request responses that echo a large body and repository objects', async () => {
		const large = { ...pull, body: 'b'.repeat(60 * 1024), head: { repo: { description: 'r'.repeat(30 * 1024) } } }
		const query = new URLSearchParams({ state: 'open', head: 'contember:work/one', base: 'main', per_page: '1' })
		const created = await open([on('POST', '/pulls', json(large, 201))])
		expect(await created.repository.openPullRequest({ ...input, body: 'b'.repeat(60 * 1024) })).toEqual({
			number: 12,
			url: pull.html_url,
			created: true,
		})
		const existing = await open([on('POST', '/pulls', json({ message: 'Validation Failed' }, 422)), on('GET', `/pulls?${query}`, json([large]))])
		expect(await existing.repository.openPullRequest(input)).toEqual({ number: 12, url: pull.html_url, created: false })
	})

	test('returns the existing open pull request when GitHub reports one for the same head and base', async () => {
		const query = new URLSearchParams({ state: 'open', head: 'contember:work/one', base: 'main', per_page: '1' })
		const { repository } = await open([
			on('POST', '/pulls', json({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] }, 422)),
			on('GET', `/pulls?${query}`, json([pull])),
		])
		expect(await repository.openPullRequest(input)).toEqual({ number: 12, url: pull.html_url, created: false })
	})

	test('keeps a 422 without an open match as a failure', async () => {
		const { repository } = await open([
			on('POST', '/pulls', json({ message: 'Validation Failed' }, 422)),
			(request) => request.url.startsWith(`${REPO}/pulls?`) ? Response.json([]) : undefined,
		])
		await expect(repository.openPullRequest(input)).rejects.toThrow('GitHub App request failed with status 422')
	})
})

describe('unknown shas', () => {
	test('a commit or tree GitHub does not know is a not-found error; a missing branch stays null', async () => {
		const { repository, requests } = await open([
			on('GET', '/git/ref/heads/work/one', json(ref('work/one', OTHER))),
			on('GET', `/git/commits/${OTHER}`, json({ message: 'No commit found for SHA' }, 422)),
			HEAD_COMMIT_ROUTE,
		])
		await expect(repository.readTree(OTHER)).rejects.toBeInstanceOf(GitHubNotFoundError)
		await expect(repository.readFiles(OTHER, ['a'])).rejects.toBeInstanceOf(GitHubNotFoundError)
		expect(await repository.readFiles(HEAD, ['a'])).toEqual({ commitSha: HEAD, files: [], unreadable: [{ path: 'a', reason: 'missing' }] })
		await expect(repository.commitFiles({
			branch: 'work/one',
			expectedHeadSha: OTHER,
			message: 'm',
			author: { name: 'Jane', email: 'jane@example.com' },
			changes: [{ path: 'a', content: 'x' }],
		})).rejects.toBeInstanceOf(GitHubNotFoundError)
		expect(requests.filter((request) => request.method !== 'GET' && request.url.startsWith(REPO))).toHaveLength(0)
		expect(await repository.readRef('missing')).toBeNull()
	})

	test('creating a branch from an unknown commit is a not-found error', async () => {
		const { repository } = await open([on('POST', '/git/refs', json({ message: 'Object does not exist' }, 422))])
		await expect(repository.createBranch({ branch: 'work/one', fromSha: OTHER })).rejects.toBeInstanceOf(GitHubNotFoundError)
	})
})

describe('redaction', () => {
	test('errors never carry the token or the response body', async () => {
		const failing = await open([
			(request) => request.url.startsWith(REPO) ? new Response(`upstream echoes ${SECRET_TOKEN}`, { status: 500 }) : undefined,
		])
		const operations = [
			failing.repository.readRef('main'),
			failing.repository.readTree(HEAD),
			failing.repository.readFiles(HEAD, ['a']),
			failing.repository.createBranch({ branch: 'x', fromSha: HEAD }),
			failing.repository.openPullRequest({ head: 'x', base: 'main', title: 't', body: '' }),
		]
		for (const operation of operations) {
			const error = await errorOf(operation)
			expect(`${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`).not.toContain(SECRET_TOKEN)
		}

		const github = fakeGitHub([])
		const app = await GitHubAppClient.create({
			appId: '123456',
			privateKeyPem: PRIVATE_KEY,
			apiBaseUrl: API,
			now: () => NOW,
			fetch: (input, init) =>
				input.toString().startsWith(REPO) ? Promise.reject(new Error(`connect failed with ${SECRET_TOKEN}`)) : github.fetch(input, init),
		})
		const repository = await app.openRepository({ installationId: 77, owner: 'contember', repository: 'fabrika' })
		const network = await errorOf(repository.readRef('main'))
		expect(network.message).toBe('GitHub repository request failed')
	})
})
