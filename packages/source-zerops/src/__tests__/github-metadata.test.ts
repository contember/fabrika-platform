import { describe, expect, test } from 'bun:test'
import { GitHubMetadataClient } from '../github-metadata'

const commitSha = 'a'.repeat(40)
const descriptor = 'zerops:\n  - setup: app\n'
const repository = { owner: 'contember', name: 'fabrika-platform' }

const commitResponse = () => Response.json({ sha: commitSha })

describe('GitHub repository metadata', () => {
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
			expect(new TextDecoder().decode(await client.descriptor(repository, commitSha, token, signal, 'resolve'))).toBe(descriptor)
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
		).rejects.toMatchObject({ code: 'archive_rejected', stage: 'archive', status: 422 })
	})

	test('maps an unknown ref to ref_not_found and an absent descriptor to descriptor_missing', async () => {
		const missing = new GitHubMetadataClient({ fetch: async () => new Response(null, { status: 404 }) })
		await expect(
			missing.commit(repository, 'main', undefined, new AbortController().signal, 'resolve'),
		).rejects.toMatchObject({ code: 'ref_not_found', stage: 'resolve', status: 404 })
		await expect(
			missing.descriptor(repository, commitSha, undefined, new AbortController().signal, 'resolve'),
		).rejects.toMatchObject({ code: 'descriptor_missing', stage: 'resolve', status: 422 })
	})

	test('refuses a descriptor larger than the registered bound without exposing it', async () => {
		const secret = 'x'.repeat(300 * 1024)
		const client = new GitHubMetadataClient({ fetch: async () => new Response(secret) })
		const raised = await client
			.descriptor(repository, commitSha, undefined, new AbortController().signal, 'archive')
			.then(() => undefined, (error: unknown) => error)

		expect(raised).toMatchObject({ code: 'archive_rejected', stage: 'archive', status: 422 })
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
				await expect(failure).rejects.toMatchObject({ code: 'internal', status: 504, retryable: true })
			} else {
				await expect(failure).rejects.toMatchObject({ code: 'cancelled', retryable: false })
			}
		},
	)

	test('bounds successful commit bodies without exposing them', async () => {
		const client = new GitHubMetadataClient({
			fetch: async () => new Response(`{"sha":"${commitSha}","secret":"${'x'.repeat(2 * 1024 * 1024)}"}`),
		})
		await expect(
			client.commit(repository, commitSha, undefined, new AbortController().signal, 'resolve'),
		).rejects.toMatchObject({ code: 'archive_rejected', status: 413 })
	})

	test('rejects an operator-supplied API origin that is not a bare HTTPS host', async () => {
		for (const apiBaseUrl of ['http://api.github.test', 'https://user:key@api.github.com', 'https://api.github.com?x=1']) {
			expect(() => new GitHubMetadataClient({ apiBaseUrl })).toThrow('GitHub metadata API URL is invalid')
		}
	})
})
