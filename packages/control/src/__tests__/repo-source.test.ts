import { describe, expect, test } from 'bun:test'
import { decodePushEvent, GitHubAppRepoSource, normalizeRepoUrl, parseGitHubRepo, pemToPkcs8, verifyWebhookSignature } from '../repo-source'
import { signWebhook } from './helpers/harness'

// Primitive-level unit tests for the control-owned RepoSource logic: HMAC-SHA256 webhook
// verification, repo-URL normalization, push decoding, and the public-repository path. The shared
// @fabrika/github-app package tests App JWT signing and GitHub API calls separately.

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
		expect(event).toEqual({ ref: 'refs/heads/deploy/prod', repoUrl: 'https://github.com/a/b.git', commitSha: 'sha1', installationId: 7 })
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

describe('GitHubAppRepoSource separation', () => {
	test('public clone and webhook verification do not require App credentials', async () => {
		const source = new GitHubAppRepoSource({ appId: '', privateKeyPem: '', webhookSecret: 'hook-secret' })
		expect(await source.clone('github.com/acme/public', 'refs/heads/main')).toEqual({
			cloneUrl: 'https://github.com/acme/public',
			ref: 'refs/heads/main',
		})
		expect((await source.clone('github.com/acme/public.git', 'refs/tags/v1')).cloneUrl).toBe('https://github.com/acme/public')
		const body = JSON.stringify({ ref: 'refs/heads/main', repository: { clone_url: 'https://github.com/acme/public.git' } })
		const signature = await signWebhook(body, 'hook-secret')
		const event = await source.verifyWebhook(
			new Request('https://control.test/webhooks/github', { method: 'POST', body, headers: { 'X-Hub-Signature-256': signature } }),
		)
		expect(event?.repoUrl).toBe('https://github.com/acme/public.git')
	})

	test('rejects caller-controlled clone destinations before creating a credential client', async () => {
		let requests = 0
		const source = new GitHubAppRepoSource({
			appId: '',
			privateKeyPem: '',
			webhookSecret: 'hook-secret',
			fetch: () => {
				requests += 1
				return Promise.reject(new Error('must not mint'))
			},
		})
		for (
			const repoUrl of [
				'https://evil.example/acme/repo',
				'https://github.com/acme/repo',
				'http://github.com/acme/repo',
				'github.com@evil.example/acme/repo',
				'github.com/acme/repo?next=evil',
				'github.com/acme/repo#fragment',
				'github.com/acme/repo/extra',
			]
		) {
			await expect(source.clone(repoUrl, 'refs/heads/main', 7)).rejects.toThrow('invalid canonical GitHub repository')
		}
		expect(requests).toBe(0)
	})

	test('ignores the hook target header as an installation-id source', async () => {
		const source = new GitHubAppRepoSource({ appId: '', privateKeyPem: '', webhookSecret: 'hook-secret' })
		const body = JSON.stringify({ ref: 'refs/heads/main', repository: { clone_url: 'https://github.com/acme/public.git' } })
		const signature = await signWebhook(body, 'hook-secret')
		const event = await source.verifyWebhook(
			new Request('https://control.test/webhooks/github', {
				method: 'POST',
				body,
				headers: { 'X-Hub-Signature-256': signature, 'X-GitHub-Hook-Installation-Target-ID': '99' },
			}),
		)
		expect(event?.installationId).toBeNull()
	})

	test('does not collapse caller cancellation into an installation lookup miss', async () => {
		const { generateKeyPairSync } = await import('node:crypto')
		const { privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		})
		let requests = 0
		const source = new GitHubAppRepoSource({
			appId: '1',
			privateKeyPem: privateKey,
			webhookSecret: 'hook-secret',
			fetch: () => {
				requests += 1
				return Promise.reject(new Error('must not run'))
			},
		})
		const controller = new AbortController()
		controller.abort('private caller reason')
		const error = await source.resolveInstallationId('github.com/acme/private', controller.signal).catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(DOMException)
		expect(error instanceof Error ? error.name : '').toBe('AbortError')
		expect(requests).toBe(0)
	})
})

describe('pemToPkcs8 (accepts both PKCS1 and PKCS8 keys)', () => {
	// GitHub App keys are PKCS1 (`BEGIN RSA PRIVATE KEY`); WebCrypto's importKey only takes PKCS8. Verify
	// pemToPkcs8 produces DER that crypto.subtle.importKey('pkcs8') accepts for BOTH PEM encodings.
	const importsAndSigns = async (pem: string): Promise<boolean> => {
		const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
		const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode('vozka'))
		return new Uint8Array(sig).length === 256
	}

	test('a PKCS1 (`BEGIN RSA PRIVATE KEY`) key imports + signs', async () => {
		const { generateKeyPairSync } = await import('node:crypto')
		const { privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
		})
		expect(privateKey).toContain('BEGIN RSA PRIVATE KEY')
		expect(await importsAndSigns(privateKey)).toBe(true)
	})

	test('a PKCS8 (`BEGIN PRIVATE KEY`) key still imports + signs', async () => {
		const { generateKeyPairSync } = await import('node:crypto')
		const { privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		})
		expect(privateKey).toContain('BEGIN PRIVATE KEY')
		expect(await importsAndSigns(privateKey)).toBe(true)
	})
})
