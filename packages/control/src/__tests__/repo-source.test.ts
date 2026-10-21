import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
	ConnectionWebhookVerifier,
	decodePushEvent,
	GITHUB_WEBHOOK_MAX_BYTES,
	normalizeRepoUrl,
	parseGitHubRepo,
	verifyWebhookSignature,
} from '../github/triggers/push-event'
import { signWebhook } from './helpers/harness'

// Primitive-level unit tests for the control-owned webhook logic: HMAC-SHA256 verification, repo-URL
// normalization and push decoding. The shared @fabrika/github-app package tests App JWT signing and
// GitHub API calls separately.

describe('verifyWebhookSignature (HMAC-SHA256)', () => {
	const secret = 'top-secret'
	const body = '{"ref":"refs/heads/main"}'

	test('accepts a correct sha256= signature', async () => {
		const sig = await signWebhook(body, secret)
		expect(await verifyWebhookSignature(body, sig, secret)).toBe(true)
	})

	test('rejects a signature computed with the wrong secret', async () => {
		const sig = await signWebhook(body, 'wrong-secret')
		expect(await verifyWebhookSignature(body, sig, secret)).toBe(false)
	})

	test('rejects a tampered body (same signature, different body)', async () => {
		const sig = await signWebhook(body, secret)
		expect(await verifyWebhookSignature('{"ref":"refs/heads/evil"}', sig, secret)).toBe(false)
	})

	test('rejects a missing / malformed signature header', async () => {
		expect(await verifyWebhookSignature(body, null, secret)).toBe(false)
		expect(await verifyWebhookSignature(body, 'not-prefixed', secret)).toBe(false)
		expect(await verifyWebhookSignature(body, 'sha256=zzzz', secret)).toBe(false) // non-hex
		expect(await verifyWebhookSignature(body, 'sha256=abc', secret)).toBe(false) // odd length
		expect(await verifyWebhookSignature(body, `sha256=${'aa'.repeat(31)}0g`, secret)).toBe(false) // partial hex pair
		expect(await verifyWebhookSignature(body, `sha256=${'a'.repeat(66)}`, secret)).toBe(false)
	})

	test('rejects an empty webhook key even when the signature was computed with it', async () => {
		const emptyKeySignature = `sha256=${createHmac('sha256', '').update(body).digest('hex')}`
		expect(await verifyWebhookSignature(body, emptyKeySignature, '')).toBe(false)
	})
})

describe('ConnectionWebhookVerifier', () => {
	const body = JSON.stringify({ ref: 'refs/heads/main', repository: { clone_url: 'https://github.com/acme/app.git' } })
	const staticSecret = (secret: string | null) => ({ getSecret: () => Promise.resolve(secret) })

	test('verifies a push signed with the connection secret', async () => {
		const events = new ConnectionWebhookVerifier(staticSecret('hook-secret'))
		const signature = await signWebhook(body, 'hook-secret')
		const event = await events.verifyWebhook(
			new Request('https://control.test/webhooks/github', {
				method: 'POST',
				body,
				headers: { 'X-Hub-Signature-256': signature, 'X-GitHub-Event': 'push' },
			}),
		)
		expect(event).toMatchObject({ kind: 'push', push: { repoUrl: 'https://github.com/acme/app.git' } })
	})

	test.each([null, ''])('fails closed when the webhook secret is %p', async (secret) => {
		const events = new ConnectionWebhookVerifier(staticSecret(secret))
		const emptyKeySignature = `sha256=${createHmac('sha256', '').update(body).digest('hex')}`
		const request = new Request('https://control.test/webhooks/github', {
			method: 'POST',
			body,
			headers: { 'X-Hub-Signature-256': emptyKeySignature },
		})
		await expect(events.verifyWebhook(request)).resolves.toBeNull()
		expect(request.bodyUsed).toBe(false)
	})

	test('rejects an oversized body before HMAC or JSON decoding', async () => {
		const events = new ConnectionWebhookVerifier(staticSecret('hook-secret'))
		const oversized = 'x'.repeat(GITHUB_WEBHOOK_MAX_BYTES + 1)
		await expect(events.verifyWebhook(
			new Request('https://control.test/webhooks/github', {
				method: 'POST',
				body: oversized,
				headers: { 'X-Hub-Signature-256': await signWebhook(oversized, 'hook-secret') },
			}),
		)).resolves.toBeNull()
	})

	test('reads a dynamic secret for every delivery', async () => {
		let secret = 'first'
		let reads = 0
		const events = new ConnectionWebhookVerifier({
			getSecret() {
				reads += 1
				return Promise.resolve(secret)
			},
		})
		const first = await signWebhook(body, secret)
		expect(
			await events.verifyWebhook(
				new Request('https://control.test/webhooks/github', {
					method: 'POST',
					body,
					headers: { 'X-Hub-Signature-256': first, 'X-GitHub-Event': 'push' },
				}),
			),
		).not.toBeNull()
		secret = 'second'
		const second = await signWebhook(body, secret)
		expect(
			await events.verifyWebhook(
				new Request('https://control.test/webhooks/github', {
					method: 'POST',
					body,
					headers: { 'X-Hub-Signature-256': second, 'X-GitHub-Event': 'push' },
				}),
			),
		).not.toBeNull()
		expect(reads).toBe(2)
	})

	test('ignores the hook target header as an installation-id source', async () => {
		const events = new ConnectionWebhookVerifier(staticSecret('hook-secret'))
		const event = await events.verifyWebhook(
			new Request('https://control.test/webhooks/github', {
				method: 'POST',
				body,
				headers: {
					'X-Hub-Signature-256': await signWebhook(body, 'hook-secret'),
					'X-GitHub-Event': 'push',
					'X-GitHub-Hook-Installation-Target-ID': '99',
				},
			}),
		)
		expect(event).toMatchObject({ kind: 'push', push: { installationId: null } })
	})
})

describe('normalizeRepoUrl', () => {
	test('reduces https / scp / .git / trailing-slash / host-case to one canonical form', () => {
		const canonical = 'github.com/acme/App'
		expect(normalizeRepoUrl('https://github.com/acme/App.git')).toBe(canonical)
		expect(normalizeRepoUrl('https://GitHub.com/acme/App/')).toBe(canonical)
		expect(normalizeRepoUrl('git@github.com:acme/App.git')).toBe(canonical)
		expect(normalizeRepoUrl('ssh://git@github.com/acme/App')).toBe(canonical)
		// Owner/repo case is preserved (only the host is lowercased).
		expect(normalizeRepoUrl('https://github.com/acme/App')).toBe(canonical)
	})
})

describe('parseGitHubRepo', () => {
	test('extracts owner/repo from any accepted URL form; null for non-github or malformed', () => {
		expect(parseGitHubRepo('https://github.com/acme/App.git')).toEqual({ owner: 'acme', repo: 'App' })
		expect(parseGitHubRepo('git@github.com:acme/App')).toEqual({ owner: 'acme', repo: 'App' })
		expect(parseGitHubRepo('github.com/acme/App')).toEqual({ owner: 'acme', repo: 'App' })
		expect(parseGitHubRepo('https://gitlab.com/acme/app')).toBeNull()
		expect(parseGitHubRepo('github.com/acme')).toBeNull()
		expect(parseGitHubRepo('github.com/acme/app/extra')).toBeNull()
	})
})

describe('decodePushEvent', () => {
	test('reads ref / clone_url / after / installation id', () => {
		const event = decodePushEvent(
			{ ref: 'refs/heads/deploy/prod', after: 'sha1', repository: { clone_url: 'https://github.com/a/b.git' }, installation: { id: 7 } },
		)
		expect(event).toEqual({
			ref: 'refs/heads/deploy/prod',
			repoUrl: 'https://github.com/a/b.git',
			commitSha: 'sha1',
			deleted: false,
			installationId: 7,
		})
	})

	test('falls back to html_url but never invents an installation id outside the payload', () => {
		const event = decodePushEvent({ ref: 'r', repository: { html_url: 'https://github.com/a/b' } })
		expect(event?.repoUrl).toBe('https://github.com/a/b')
		expect(event?.installationId).toBeNull()
		expect(event?.commitSha).toBeNull()
	})

	test('returns null when ref or repo is missing', () => {
		expect(decodePushEvent({ repository: { clone_url: 'x' } })).toBeNull()
		expect(decodePushEvent({ ref: 'r' })).toBeNull()
	})
})
