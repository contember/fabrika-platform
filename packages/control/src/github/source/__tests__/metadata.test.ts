import { describe, expect, test } from 'bun:test'
import { GitHubMetadataClient } from '../metadata'
import { SOURCE_MAX_TREE_ENTRIES } from '../tree'

const DESCRIPTOR = { path: 'zerops.yaml', maxBytes: 256 * 1024 }

const commitSha = 'a'.repeat(40)
const descriptor = 'zerops:\n  - setup: app\n'
const repository = { owner: 'contember', name: 'fabrika-platform' }

const commitResponse = () => Response.json({ sha: commitSha })
const treeSha = 'b'.repeat(40)
const blob = { path: 'CLAUDE.md', mode: '100644', type: 'blob', sha: 'c'.repeat(40), size: 12 }
const treeResponse = { sha: treeSha, truncated: false, tree: [blob] }

describe('platform Git tree preflight', () => {
	test('accepts response extensions and absent sizes on both directories and blobs', async () => {
		const client = platformClient(() =>
			Response.json({
				...treeResponse,
				url: 'ignored',
				tree: [
					{ path: 'dir', mode: '040000', type: 'tree', sha: treeSha, extension: true },
					{ path: 'dir/file', mode: '100755', type: 'blob', sha: 'c'.repeat(64), extension: true },
				],
			})
		)
		await expect(client.validatePlatformTree(repository, commitSha, new AbortController().signal)).resolves.toBeUndefined()
	})

	test('binds a complete recursive tree to the exact commit and accepts symlink blobs', async () => {
		const calls: string[] = []
		const client = new GitHubMetadataClient({
			fetch: async (input, init) => {
				calls.push(input.toString())
				expect(new Headers(init?.headers).get('authorization')).toBeNull()
				expect(init?.redirect).toBe('error')
				return input.toString().includes('/commits/')
					? Response.json({ sha: commitSha, commit: { tree: { sha: treeSha } } })
					: Response.json({ ...treeResponse, tree: [blob, { ...blob, path: 'AGENTS.md', mode: '120000' }] })
			},
		})
		await client.validatePlatformTree(repository, commitSha, new AbortController().signal)
		expect(calls).toEqual([
			`https://api.github.com/repos/contember/fabrika-platform/commits/${commitSha}`,
			`https://api.github.com/repos/contember/fabrika-platform/git/trees/${treeSha}?recursive=1`,
		])
	})

	test.each([
		{ name: 'wrong commit', body: { sha: treeSha, commit: { tree: { sha: treeSha } } }, code: 'commit_mismatch' },
		{ name: 'missing tree', body: { sha: commitSha }, code: 'archive_rejected' },
		{ name: 'invalid tree sha', body: { sha: commitSha, commit: { tree: { sha: 'main' } } }, code: 'archive_rejected' },
	])('rejects $name before requesting a tree', async ({ body, code }) => {
		let calls = 0
		const client = new GitHubMetadataClient({
			fetch: async () => {
				calls++
				return Response.json(body)
			},
		})
		await expect(client.validatePlatformTree(repository, commitSha, new AbortController().signal)).rejects.toMatchObject({ code, stage: 'archive' })
		expect(calls).toBe(1)
	})

	test.each([
		{ name: 'markerless gitlink', body: { ...treeResponse, tree: [{ ...blob, path: 'vendor', mode: '160000', type: 'commit' }] } },
		{ name: 'gitlink mode with false blob type', body: { ...treeResponse, tree: [{ ...blob, mode: '160000' }] } },
		{ name: 'commit type with false blob mode', body: { ...treeResponse, tree: [{ ...blob, type: 'commit' }] } },
		{ name: 'truncated tree', body: { ...treeResponse, truncated: true } },
		{ name: 'missing truncation flag', body: { sha: treeSha, tree: [blob] } },
		{ name: 'wrong tree identity', body: { ...treeResponse, sha: commitSha } },
		{ name: 'missing entries', body: { sha: treeSha, truncated: false } },
		{ name: 'non-array entries', body: { ...treeResponse, tree: {} } },
		{ name: 'invalid entry', body: { ...treeResponse, tree: [null] } },
		{ name: 'unknown mode', body: { ...treeResponse, tree: [{ ...blob, mode: '100600' }] } },
		{ name: 'invalid sha', body: { ...treeResponse, tree: [{ ...blob, sha: null }] } },
		{ name: 'invalid size', body: { ...treeResponse, tree: [{ ...blob, size: -1 }] } },
		{ name: 'invalid path', body: { ...treeResponse, tree: [{ ...blob, path: '../escape' }] } },
		{ name: 'duplicate path', body: { ...treeResponse, tree: [blob, blob] } },
		{ name: 'missing parent tree', body: { ...treeResponse, tree: [{ ...blob, path: 'dir/file' }] } },
		{ name: 'blob parent', body: { ...treeResponse, tree: [blob, { ...blob, path: 'CLAUDE.md/file' }] } },
	])('fails closed on $name', async ({ body }) => {
		const client = platformClient(() => Response.json(body))
		await expect(client.validatePlatformTree(repository, commitSha, new AbortController().signal)).rejects.toMatchObject({
			code: 'archive_rejected',
			stage: 'archive',
		})
	})

	test.each([
		{
			name: 'too many entries',
			response: () => Response.json({ ...treeResponse, tree: Array.from({ length: SOURCE_MAX_TREE_ENTRIES + 1 }, () => blob) }),
		},
		{
			name: 'announced oversized body',
			response: () => new Response('{}', { headers: { 'content-length': String(7 * 1024 * 1024 + 1) } }),
		},
		{ name: 'streamed oversized body', response: () => new Response('x'.repeat(7 * 1024 * 1024 + 1)) },
		{ name: 'malformed JSON', response: () => new Response('{') },
		{ name: 'invalid UTF-8', response: () => new Response(new Uint8Array([0xff])) },
	])('bounds and rejects $name', async ({ response }) => {
		await expect(platformClient(response).validatePlatformTree(repository, commitSha, new AbortController().signal)).rejects.toMatchObject({
			code: 'archive_rejected',
			stage: 'archive',
		})
	})
})

function platformClient(tree: () => Response): GitHubMetadataClient {
	return new GitHubMetadataClient({
		fetch: async (input) =>
			input.toString().includes('/commits/')
				? Response.json({ sha: commitSha, commit: { tree: { sha: treeSha } } })
				: tree(),
	})
}

describe('GitHub repository metadata', () => {
	test.each([
		{ name: 'absent', commit: undefined },
		{ name: 'null', commit: null },
		{ name: 'array', commit: [] },
		{ name: 'string', commit: 'ignored' },
		{ name: 'missing tree', commit: {} },
		{ name: 'null tree', commit: { tree: null } },
		{ name: 'invalid sha', commit: { tree: { sha: 'invalid' } } },
	])(
		'resolves the commit while tolerating unusable optional tree metadata: $name',
		async ({ commit }) => {
			const client = new GitHubMetadataClient({
				fetch: async () => Response.json({ sha: commitSha, commit, extension: 'ignored' }),
			})
			expect(await client.commit(repository, 'main', undefined, new AbortController().signal, 'resolve')).toBe(commitSha)
			await expect(client.validatePlatformTree(repository, commitSha, new AbortController().signal)).rejects.toMatchObject({
				code: 'archive_rejected',
				stage: 'archive',
			})
		},
	)

	test.each([
		{ token: undefined, authorization: null },
		{ token: 'ghs_private_repository', authorization: 'Bearer ghs_private_repository' },
	])(
		'uses exact bounded REST paths and the $authorization authorization boundary',
		async ({ token, authorization }) => {
			const calls: Array<{ url: string; accept: string | null; authorization: string | null; signal: AbortSignal | null }> = []
			const client = new GitHubMetadataClient({
				fetch: async (input, init) => {
					const url = input.toString()
					const headers = new Headers(init?.headers)
					calls.push({
						url,
						accept: headers.get('accept'),
						authorization: headers.get('authorization'),
						signal: init?.signal ?? null,
					})
					return url.includes('/commits/') ? commitResponse() : new Response(descriptor)
				},
			})
			const signal = new AbortController().signal

			expect(await client.commit(repository, 'refs/heads/main', token, signal, 'resolve')).toBe(commitSha)
			expect(
				new TextDecoder().decode(await client.readFileAtCommit(repository, DESCRIPTOR.path, DESCRIPTOR.maxBytes, commitSha, token, signal, 'resolve')),
			).toBe(descriptor)
			expect(calls.map((call) => call.url)).toEqual([
				'https://api.github.com/repos/contember/fabrika-platform/commits/refs%2Fheads%2Fmain',
				`https://api.github.com/repos/contember/fabrika-platform/contents/zerops.yaml?ref=${commitSha}`,
			])
			expect(calls.map((call) => call.accept)).toEqual([
				'application/vnd.github+json',
				'application/vnd.github.raw+json',
			])
			expect(calls.every((call) => call.authorization === authorization)).toBe(true)
			expect(calls.every((call) => call.signal !== signal)).toBe(true)
		},
	)

	test.each([
		{ name: 'a non-object body', body: '[]' },
		{ name: 'a missing commit sha', body: '{}' },
		{ name: 'an object id that is not hex', body: JSON.stringify({ sha: 'refs/heads/main' }) },
		{ name: 'a body that is not JSON', body: 'not json' },
	])('rejects $name from the commit endpoint', async ({ body }) => {
		const client = new GitHubMetadataClient({ fetch: async () => new Response(body) })
		await expect(
			client.commit(repository, 'main', undefined, new AbortController().signal, 'archive'),
		).rejects.toMatchObject({ code: 'archive_rejected', stage: 'archive' })
	})

	test('maps an unknown ref to ref_not_found and an absent descriptor to descriptor_missing', async () => {
		const missing = new GitHubMetadataClient({ fetch: async () => new Response(null, { status: 404 }) })
		await expect(
			missing.commit(repository, 'main', undefined, new AbortController().signal, 'resolve'),
		).rejects.toMatchObject({ code: 'ref_not_found', stage: 'resolve' })
		await expect(
			missing.readFileAtCommit(repository, DESCRIPTOR.path, DESCRIPTOR.maxBytes, commitSha, undefined, new AbortController().signal, 'resolve'),
		).rejects.toMatchObject({ code: 'descriptor_missing', stage: 'resolve' })
	})

	test('refuses a descriptor larger than the registered bound without exposing it', async () => {
		const secret = 'x'.repeat(300 * 1024)
		const client = new GitHubMetadataClient({ fetch: async () => new Response(secret) })
		const raised = await client
			.readFileAtCommit(repository, DESCRIPTOR.path, DESCRIPTOR.maxBytes, commitSha, undefined, new AbortController().signal, 'archive')
			.then(() => undefined, (error: unknown) => error)

		expect(raised).toMatchObject({ code: 'archive_rejected', stage: 'archive' })
		expect(JSON.stringify(raised)).not.toContain('xxx')
	})

	test.each(['timeout', 'caller cancellation'])(
		'bounds REST operations and preserves %s',
		async (name) => {
			const controller = new AbortController()
			const client = new GitHubMetadataClient({
				timeoutMs: name === 'timeout' ? 10 : 5_000,
				fetch: async (_input, init) =>
					await new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true })
					}),
			})
			if (name === 'caller cancellation') setTimeout(() => controller.abort(), 10)
			const failure = client.commit(repository, commitSha, undefined, controller.signal, 'resolve')
			if (name === 'timeout') {
				await expect(failure).rejects.toMatchObject({ code: 'internal' })
			} else {
				await expect(failure).rejects.toMatchObject({ code: 'cancelled' })
			}
		},
	)

	test('bounds successful commit bodies without exposing them', async () => {
		const client = new GitHubMetadataClient({
			fetch: async () => new Response(`{"sha":"${commitSha}","secret":"${'x'.repeat(2 * 1024 * 1024)}"}`),
		})
		await expect(
			client.commit(repository, commitSha, undefined, new AbortController().signal, 'resolve'),
		).rejects.toMatchObject({ code: 'archive_rejected' })
	})
})
