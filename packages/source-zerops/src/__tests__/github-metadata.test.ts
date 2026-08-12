import { describe, expect, test } from 'bun:test'
import { GitHubMetadataClient } from '../github-metadata'
import { GitRepositorySource, SOURCE_MAX_EXPANDED_BYTES } from '../repository'

const commitSha = 'a'.repeat(40)
const treeSha = 'b'.repeat(40)
const descriptorObjectId = 'c'.repeat(40)
const repository = { owner: 'contember', name: 'fabrika-platform' }

const commitResponse = () => Response.json({ sha: commitSha, commit: { tree: { sha: treeSha } } })
const treeResponse = (overrides: Record<string, unknown> = {}) =>
	Response.json({
		sha: treeSha,
		truncated: false,
		tree: [
			{
				path: 'zerops.yaml',
				mode: '100644',
				type: 'blob',
				sha: descriptorObjectId,
				size: 25,
			},
		],
		...overrides,
	})

describe('GitHub repository metadata', () => {
	test.each([
		{ token: undefined, authorization: null },
		{
			token: 'ghs_private_repository',
			authorization: 'Bearer ghs_private_repository',
		},
	])(
		'uses exact bounded REST paths and the $authorization authorization boundary',
		async ({ token, authorization }) => {
			const calls: Array<{
				url: string
				authorization: string | null
				signal: AbortSignal | null
			}> = []
			const client = new GitHubMetadataClient({
				fetch: async (input, init) => {
					const url = input.toString()
					calls.push({
						url,
						authorization: new Headers(init?.headers).get('authorization'),
						signal: init?.signal ?? null,
					})
					return url.includes('/commits/') ? commitResponse() : treeResponse()
				},
			})
			const signal = new AbortController().signal
			expect(
				await client.snapshot(
					repository,
					'refs/heads/main',
					token,
					signal,
					'resolve',
				),
			).toEqual({
				commitSha,
				treeSha,
				entries: [
					{
						path: 'zerops.yaml',
						mode: '100644',
						type: 'blob',
						objectId: descriptorObjectId,
						size: 25,
					},
				],
			})
			expect(calls.map((call) => call.url)).toEqual([
				'https://api.github.com/repos/contember/fabrika-platform/commits/refs%2Fheads%2Fmain',
				`https://api.github.com/repos/contember/fabrika-platform/git/trees/${treeSha}?recursive=1`,
			])
			expect(calls.every((call) => call.authorization === authorization)).toBe(
				true,
			)
			expect(calls.every((call) => call.signal !== signal)).toBe(true)
		},
	)

	test.each([
		{ name: 'truncated tree', response: treeResponse({ truncated: true }) },
		{
			name: 'different root tree',
			response: treeResponse({ sha: 'd'.repeat(40) }),
		},
		{
			name: 'missing blob size',
			response: treeResponse({
				tree: [
					{
						path: 'zerops.yaml',
						mode: '100644',
						type: 'blob',
						sha: descriptorObjectId,
					},
				],
			}),
		},
		{
			name: 'symlink',
			response: treeResponse({
				tree: [
					{
						path: 'link',
						mode: '120000',
						type: 'blob',
						sha: descriptorObjectId,
						size: 4,
					},
				],
			}),
		},
		{
			name: 'submodule',
			response: treeResponse({
				tree: [
					{
						path: 'module',
						mode: '160000',
						type: 'commit',
						sha: descriptorObjectId,
					},
				],
			}),
		},
		{
			name: 'unsafe path',
			response: treeResponse({
				tree: [
					{
						path: '../zerops.yaml',
						mode: '100644',
						type: 'blob',
						sha: descriptorObjectId,
						size: 4,
					},
				],
			}),
		},
	])('rejects $name metadata', async ({ response }) => {
		const client = metadataWithTree(response)
		await expect(
			client.snapshot(
				repository,
				commitSha,
				undefined,
				new AbortController().signal,
				'archive',
			),
		).rejects.toMatchObject({
			code: 'archive_rejected',
			stage: 'archive',
			retryable: false,
		})
	})

	test('enforces expanded bytes before Git fetch or any blob retrieval', async () => {
		let originCalls = 0
		let blobReads = 0
		const metadata = metadataWithTree(
			treeResponse({
				tree: [
					{
						path: 'zerops.yaml',
						mode: '100644',
						type: 'blob',
						sha: descriptorObjectId,
						size: SOURCE_MAX_EXPANDED_BYTES,
					},
					{
						path: 'extra',
						mode: '100644',
						type: 'blob',
						sha: 'd'.repeat(40),
						size: 1,
					},
				],
			}),
		)
		const source = new GitRepositorySource({
			metadata,
			repositoryUrl: () => {
				originCalls++
				return 'https://github.com/contember/fabrika-platform.git'
			},
			onBlobRead: () => blobReads++,
		})
		await expect(
			source.resolve({
				repository,
				requestedRef: commitSha,
				descriptorSha256: 'e'.repeat(64),
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'archive_rejected', status: 413 })
		expect(originCalls).toBe(0)
		expect(blobReads).toBe(0)
	})

	test.each(['timeout', 'caller cancellation'])(
		'bounds REST operations and preserves $name',
		async (name) => {
			const controller = new AbortController()
			const client = new GitHubMetadataClient({
				timeoutMs: name === 'timeout' ? 10 : 5_000,
				fetch: async (_input, init) =>
					await new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							'abort',
							() => reject(new DOMException('stopped', 'AbortError')),
							{ once: true },
						)
					}),
			})
			if (name === 'caller cancellation') {
				setTimeout(() => controller.abort(), 10)
			}
			const failure = client.snapshot(
				repository,
				commitSha,
				undefined,
				controller.signal,
				'resolve',
			)
			if (name === 'timeout') {
				await expect(failure).rejects.toMatchObject({
					code: 'internal',
					status: 504,
					retryable: true,
				})
			} else {
				await expect(failure).rejects.toMatchObject({
					code: 'cancelled',
					retryable: false,
				})
			}
		},
	)

	test('bounds successful response bodies without exposing them', async () => {
		const client = new GitHubMetadataClient({
			fetch: async () =>
				new Response(
					`{"sha":"${commitSha}","secret":"${'x'.repeat(1024 * 1024)}"}`,
				),
		})
		await expect(
			client.snapshot(
				repository,
				commitSha,
				undefined,
				new AbortController().signal,
				'resolve',
			),
		).rejects.toMatchObject({
			code: 'archive_rejected',
			status: 413,
		})
	})
})

function metadataWithTree(response: Response): GitHubMetadataClient {
	let calls = 0
	return new GitHubMetadataClient({
		fetch: async () => {
			calls++
			return calls === 1 ? commitResponse() : response
		},
	})
}
