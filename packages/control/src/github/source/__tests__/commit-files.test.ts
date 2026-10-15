import { describe, expect, test } from 'bun:test'
import { gitHubCommitSource } from '../commit-files'
import { GitHubMetadataClient } from '../metadata'

const credentials = {
	repositoryToken: () => Promise.reject(new Error('an anonymous probe must not mint a repository token')),
	ownerConnectionToken: () => Promise.reject(new Error('an anonymous probe must not mint a repository token')),
}

const probe = async (answer: () => Response): Promise<{ readability: string; calls: string[] }> => {
	const calls: string[] = []
	const metadata = new GitHubMetadataClient({
		fetch: async (input, init) => {
			calls.push(input.toString())
			expect(new Headers(init?.headers).get('authorization')).toBeNull()
			return answer()
		},
	})
	const readability = await gitHubCommitSource(metadata, credentials).anonymousReadability({
		repoUrl: 'github.com/acme/notes',
		signal: new AbortController().signal,
	})
	return { readability, calls }
}

describe('the anonymous readability probe', () => {
	test('resolves HEAD once, without a token', async () => {
		const result = await probe(() => Response.json({ sha: 'a'.repeat(40) }))

		expect(result).toEqual({ readability: 'readable', calls: ['https://api.github.com/repos/acme/notes/commits/HEAD'] })
	})

	test('reads a 404 as unreadable: GitHub hides a private repository from an anonymous caller', async () => {
		expect((await probe(() => new Response(null, { status: 404 }))).readability).toBe('unreadable')
	})

	test('gives no verdict on any other failure', async () => {
		expect((await probe(() => new Response(null, { status: 403 }))).readability).toBe('unknown')
		expect((await probe(() => new Response(null, { status: 502 }))).readability).toBe('unknown')
	})
})
