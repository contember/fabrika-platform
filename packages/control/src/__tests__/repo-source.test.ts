import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
	decodePushEvent,
	GITHUB_WEBHOOK_MAX_BYTES,
	GitHubAppRepoSource,
	LocalGitHubRepoEvents,
	normalizeRepoUrl,
	parseGitHubRepo,
	pemToPkcs8,
	verifyWebhookSignature,
} from '../repo-source'
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
		expect(await verifyWebhookSignature(body, `sha256=${'aa'.repeat(31)}0g`, secret)).toBe(false) // partial hex pair
		expect(await verifyWebhookSignature(body, `sha256=${'a'.repeat(66)}`, secret)).toBe(false)
	})

	test('rejects an empty webhook key even when the signature was computed with it', async () => {
		const emptyKeySignature = `sha256=${createHmac('sha256', '').update(body).digest('hex')}`
		expect(await verifyWebhookSignature(body, emptyKeySignature, '')).toBe(false)
	})
})

describe('LocalGitHubRepoEvents', () => {
	const body = JSON.stringify({ ref: 'refs/heads/main', repository: { clone_url: 'https://github.com/acme/app.git' } })

	test('keeps webhook HMAC local and delegates installation lookup with the caller signal', async () => {
		const calls: Array<{ repoUrl: string; signal?: AbortSignal }> = []
		const events = new LocalGitHubRepoEvents('hook-secret', {
			resolveInstallationId(repoUrl, signal) {
				calls.push({ repoUrl, ...(signal === undefined ? {} : { signal }) })
				return Promise.resolve(73)
			},
		})
		const signal = new AbortController().signal
		await expect(events.resolveInstallationId('github.com/acme/app', signal)).resolves.toBe(73)
		expect(calls).toEqual([{ repoUrl: 'github.com/acme/app', signal }])

		const signature = await signWebhook(body, 'hook-secret')
		const event = await events.verifyWebhook(
			new Request('https://control.test/webhooks/github', {
				method: 'POST',
				body,
				headers: { 'X-Hub-Signature-256': signature },
			}),
		)
		expect(event?.repoUrl).toBe('https://github.com/acme/app.git')
	})

	test.each([undefined, ''])('fails closed when the webhook secret is %s', async (secret) => {
		let lookups = 0
		const events = new LocalGitHubRepoEvents(secret, {
			resolveInstallationId() {
				lookups += 1
				return Promise.resolve(null)
			},
		})
		const emptyKeySignature = `sha256=${createHmac('sha256', '').update(body).digest('hex')}`
		const request = new Request('https://control.test/webhooks/github', {
			method: 'POST',
			body,
			headers: { 'X-Hub-Signature-256': emptyKeySignature },
		})
		await expect(events.verifyWebhook(request)).resolves.toBeNull()
		expect(lookups).toBe(0)
		expect(request.bodyUsed).toBe(false)
	})

	test('rejects an oversized body before HMAC or JSON decoding', async () => {
		const events = new LocalGitHubRepoEvents('hook-secret', { resolveInstallationId: () => Promise.resolve(null) })
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
		const events = new LocalGitHubRepoEvents({
			getSecret() {
				reads += 1
				return Promise.resolve(secret)
			},
		}, { resolveInstallationId: () => Promise.resolve(null) })
		const first = await signWebhook(body, secret)
		expect(
			await events.verifyWebhook(
				new Request('https://control.test/webhooks/github', {
					method: 'POST',
					body,
					headers: { 'X-Hub-Signature-256': first },
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
					headers: { 'X-Hub-Signature-256': second },
				}),
			),
		).not.toBeNull()
		expect(reads).toBe(2)
	})

	test('a missing dynamic secret fails before reading the unauthenticated body', async () => {
		const events = new LocalGitHubRepoEvents({ getSecret: () => Promise.resolve(null) }, {
			resolveInstallationId: () => Promise.resolve(null),
		})
		const request = new Request('https://control.test/webhooks/github', { method: 'POST', body })
		await expect(events.verifyWebhook(request)).resolves.toBeNull()
		expect(request.bodyUsed).toBe(false)
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
	test('passes pre-aborted and in-flight caller cancellation through private clone token minting', async () => {
		const { generateKeyPairSync } = await import('node:crypto')
		const { privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		})
		let requests = 0
		const started = Promise.withResolvers<void>()
		const source = new GitHubAppRepoSource({
			appId: '1',
			privateKeyPem: privateKey,
			webhookSecret: 'hook-secret',
			fetch: (_url, init) => {
				requests += 1
				started.resolve()
				const signal = init?.signal
				if (!(signal instanceof AbortSignal)) throw new Error('expected caller-linked signal')
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('private reason')), { once: true })
				})
			},
		})

		const preAborted = new AbortController()
		preAborted.abort('private reason')
		const first = await source.clone('github.com/acme/private', 'refs/heads/main', 7, preAborted.signal).catch((error: unknown) => error)
		expect(first).toBeInstanceOf(DOMException)
		expect(first instanceof Error ? first.name : '').toBe('AbortError')
		expect(requests).toBe(0)

		const inFlight = new AbortController()
		const pending = source.clone('github.com/acme/private', 'refs/heads/main', 7, inFlight.signal)
		await started.promise
		inFlight.abort('private reason')
		const second = await pending.catch((error: unknown) => error)
		expect(second).toBeInstanceOf(DOMException)
		expect(second instanceof Error ? second.name : '').toBe('AbortError')
		expect(second instanceof Error ? second.message : '').not.toContain('private')
		expect(requests).toBe(1)
	})

	test('rejects an oversized webhook body', async () => {
		const source = new GitHubAppRepoSource({ appId: '', privateKeyPem: '', webhookSecret: 'hook-secret' })
		const oversized = 'x'.repeat(GITHUB_WEBHOOK_MAX_BYTES + 1)
		await expect(source.verifyWebhook(
			new Request('https://control.test/webhooks/github', {
				method: 'POST',
				body: oversized,
				headers: { 'X-Hub-Signature-256': await signWebhook(oversized, 'hook-secret') },
			}),
		)).resolves.toBeNull()
	})

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
