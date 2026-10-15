import { describe, expect, test } from 'bun:test'
import { rateLimitFailure, SourceFailure, SourceRateLimited } from '../failure'
import { GitHubMetadataClient } from '../metadata'

const NOW = Date.UTC(2026, 9, 15, 20, 0, 0)
const repository = { owner: 'acme', name: 'notes' }
const signal = new AbortController().signal

const refusal = (status: number, headers: Record<string, string> = {}) => new Response('{"message":"API rate limit exceeded"}', { status, headers })

describe('GitHub rate-limit classification', () => {
	test('a 403 that spent the limit is a rate limit with the reset GitHub names', () => {
		const failure = rateLimitFailure(refusal(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 600) }), 'resolve', true)

		expect(failure).toBeInstanceOf(SourceRateLimited)
		expect(failure?.code).toBe('rate_limited')
		expect(failure?.resetAt?.getTime()).toBe(NOW + 600_000)
		expect(failure?.message).toBe(
			'GitHub rate limit for anonymous reads reached; resets at 2026-10-15T20:10:00.000Z; connect the GitHub App to avoid it',
		)
	})

	test('retry-after outranks the reset header, on a 403 and on a 429', () => {
		for (const status of [403, 429]) {
			const failure = rateLimitFailure(refusal(status, { 'retry-after': '60', 'x-ratelimit-reset': '1' }), 'archive', false, () => NOW)
			expect(failure?.resetAt?.getTime()).toBe(NOW + 60_000)
			expect(failure?.message).toBe("GitHub rate limit for the GitHub App's reads reached; resets at 2026-10-15T20:01:00.000Z")
		}
	})

	test('a 429 without headers is still a rate limit, and says to retry later', () => {
		expect(rateLimitFailure(refusal(429), 'resolve', true)?.message).toBe(
			'GitHub rate limit for anonymous reads reached; retry later; connect the GitHub App to avoid it',
		)
	})

	test('a plain 403 and a 403 with quota left are not rate limits', () => {
		expect(rateLimitFailure(refusal(403), 'resolve', true)).toBeNull()
		expect(rateLimitFailure(refusal(403, { 'x-ratelimit-remaining': '12' }), 'resolve', true)).toBeNull()
		expect(rateLimitFailure(refusal(500, { 'x-ratelimit-remaining': '0' }), 'resolve', true)).toBeNull()
	})

	test('the metadata client reports an anonymous rate limit, not an internal failure', async () => {
		const client = new GitHubMetadataClient({
			fetch: async () => refusal(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000) }),
		})

		const failure = client.commit(repository, 'main', undefined, signal, 'resolve')

		await expect(failure).rejects.toBeInstanceOf(SourceRateLimited)
		await expect(failure).rejects.toMatchObject({ code: 'rate_limited', stage: 'resolve', anonymous: true })
	})

	test('a token-bearing read that hits the limit names the App, and any other refusal stays internal', async () => {
		const limited = new GitHubMetadataClient({ fetch: async () => refusal(429, { 'retry-after': '5' }) })
		await expect(limited.commit(repository, 'main', 'token', signal, 'resolve')).rejects.toMatchObject({ anonymous: false })

		const refused = new GitHubMetadataClient({ fetch: async () => refusal(403) })
		const failure = refused.commit(repository, 'main', undefined, signal, 'resolve')
		await expect(failure).rejects.toBeInstanceOf(SourceFailure)
		await expect(failure).rejects.toMatchObject({ code: 'internal' })
	})
})
