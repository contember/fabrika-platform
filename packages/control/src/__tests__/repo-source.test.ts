import type { GitHubAppFetch } from '@fabrika/github-app'
import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { getEventListeners } from 'node:events'
import {
	ConnectionWebhookVerifier,
	decodePushEvent,
	GITHUB_WEBHOOK_MAX_BYTES,
	type GitHubAppConfig,
	GitHubAppRepoSource,
	normalizeRepoUrl,
	parseGitHubRepo,
	pemToPkcs8,
	verifyWebhookSignature,
} from '../repo-source'
import { SourceFailure } from '../source/failure'
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
				headers: { 'X-Hub-Signature-256': signature },
			}),
		)
		expect(event?.repoUrl).toBe('https://github.com/acme/app.git')
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
	test('preserves pre-aborted and in-flight deployment reasons through private clone token minting', async () => {
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
		const firstReason = new ProviderInvocationAbort('lease_lost')
		preAborted.abort(firstReason)
		const first = await source.clone('github.com/acme/private', 'refs/heads/main', 7, preAborted.signal).catch((error: unknown) => error)
		expect(first).toBe(firstReason)
		expect(requests).toBe(0)

		const inFlight = new AbortController()
		const pending = source.clone('github.com/acme/private', 'refs/heads/main', 7, inFlight.signal)
		await started.promise
		const secondReason = new ProviderInvocationAbort('cancel_requested')
		inFlight.abort(secondReason)
		const second = await pending.catch((error: unknown) => error)
		expect(second).toBe(secondReason)
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

interface SourceHttpRequest {
	url: string
	headers: Headers
	redirect: RequestRedirect | undefined
	signal: AbortSignal | null | undefined
	method: string | undefined
	body: BodyInit | null | undefined
}

function sourceHttpStub(responses: Response[]): { fetch: GitHubAppFetch; requests: SourceHttpRequest[] } {
	const requests: SourceHttpRequest[] = []
	return {
		requests,
		fetch(input, init) {
			requests.push({
				url: input instanceof Request ? input.url : input.toString(),
				headers: new Headers(init?.headers),
				redirect: init?.redirect,
				signal: init?.signal,
				method: init?.method,
				body: init?.body,
			})
			const response = responses.shift()
			if (response === undefined) return Promise.reject(new Error('unexpected HTTP stub request'))
			return Promise.resolve(response)
		},
	}
}

function publicSource(fetch: GitHubAppFetch, config: Partial<GitHubAppConfig> = {}): GitHubAppRepoSource {
	return new GitHubAppRepoSource({ appId: '', privateKeyPem: '', webhookSecret: '', fetch, ...config })
}

function expectNoAbortListeners(signal: AbortSignal | null | undefined): void {
	if (!(signal instanceof AbortSignal)) throw new Error('expected source request signal')
	expect(getEventListeners(signal, 'abort')).toHaveLength(0)
}

const SOURCE_COMMIT = 'a'.repeat(40)
const SOURCE_REPO = 'github.com/acme/app'
const COMMITS_URL = 'https://api.github.com/repos/acme/app/commits/'
const sourceCommitResponse = (sha = SOURCE_COMMIT): Response => Response.json({ sha })

function abortRejectingFetch(started?: () => void): GitHubAppFetch {
	return (_input, init) => {
		started?.()
		return new Promise<Response>((_resolve, reject) =>
			init?.signal?.addEventListener('abort', () => reject(new Error('private transport reason')), { once: true })
		)
	}
}

describe('GitHubAppRepoSource.resolveCommit (native HTTP stubs, not live GitHub)', () => {
	// GitHub peels an annotated tag itself, so every ref kind is one `GET /commits/{ref}`.
	test.each([
		{ kind: 'a branch', ref: 'main' },
		{ kind: 'a qualified branch', ref: 'refs/heads/deploy/prod' },
		{ kind: 'a lightweight tag', ref: 'v1' },
		{ kind: 'an annotated tag', ref: 'refs/tags/v1-annotated' },
		{ kind: 'a full SHA', ref: SOURCE_COMMIT },
	])('resolves $kind to its commit with one anonymous public request', async ({ ref }) => {
		const http = sourceHttpStub([sourceCommitResponse()])
		expect(await publicSource(http.fetch).resolveCommit(`${SOURCE_REPO}.git`, ref)).toEqual({ commitSha: SOURCE_COMMIT })
		expect(http.requests.map((request) => request.url)).toEqual([`${COMMITS_URL}${encodeURIComponent(ref)}`])
		const [request] = http.requests
		expect(request?.headers.has('authorization')).toBe(false)
		expect(request?.headers.get('accept')).toBe('application/vnd.github+json')
		expect(request?.redirect).toBe('error')
	})

	test('a missing ref fails as ref_not_found without exposing the upstream body', async () => {
		const http = sourceHttpStub([new Response('private response body', { status: 404 })])
		const error = await publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'missing').catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(SourceFailure)
		expect(error).toMatchObject({ code: 'ref_not_found', stage: 'resolve' })
		expect(JSON.stringify(error)).not.toContain('private')
	})

	test('a request past the configured timeout fails as an internal source failure', async () => {
		const error = await publicSource(abortRejectingFetch(), { timeoutMs: 10 }).resolveCommit(SOURCE_REPO, 'main').catch((cause: unknown) => cause)
		expect(error).toBeInstanceOf(SourceFailure)
		expect(error).toMatchObject({ code: 'internal', stage: 'resolve' })
	})

	test('redacts ordinary transport errors', async () => {
		const failure = await publicSource(() => Promise.reject(new Error('https://token@github.com/private')))
			.resolveCommit(SOURCE_REPO, 'main')
			.catch((cause: unknown) => cause)
		expect(failure).toMatchObject({ code: 'internal', stage: 'resolve' })
		expect(failure instanceof Error ? failure.message : '').not.toContain('token')
	})

	test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 120001])('validates the timeout seam before HTTP (%s)', async (timeoutMs) => {
		const http = sourceHttpStub([])
		await expect(publicSource(http.fetch, { timeoutMs }).resolveCommit(SOURCE_REPO, SOURCE_COMMIT)).rejects.toThrow(
			'GitHub source configuration is invalid',
		)
		expect(http.requests).toHaveLength(0)
	})

	test.each(['lease_lost', 'cancel_requested'])(
		'preserves the exact %s reason before and during the request',
		async (kind: 'lease_lost' | 'cancel_requested') => {
			const reason = new ProviderInvocationAbort(kind)
			const before = new AbortController()
			before.abort(reason)
			const idle = sourceHttpStub([])
			expect(await publicSource(idle.fetch).resolveCommit(SOURCE_REPO, 'main', null, before.signal).catch((cause: unknown) => cause)).toBe(reason)
			expect(idle.requests).toHaveLength(0)

			const during = new AbortController()
			const started = Promise.withResolvers<void>()
			const pending = publicSource(abortRejectingFetch(() => started.resolve())).resolveCommit(SOURCE_REPO, 'main', null, during.signal)
			await started.promise
			during.abort(reason)
			expect(await pending.catch((cause: unknown) => cause)).toBe(reason)
		},
	)
})

describe('GitHubAppRepoSource deployment token authority (native HTTP stubs, not live GitHub)', () => {
	const { privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	})
	const credentials = { appId: '1', privateKeyPem: privateKey }
	const tokenResponse = (): Response => Response.json({ token: 'test-installation-token', expires_at: '2030-01-01T00:00:00Z' })

	function pendingTokenHttpStub() {
		const response = Promise.withResolvers<Response>()
		const started = Promise.withResolvers<AbortSignal>()
		const requests: string[] = []
		const fetch: GitHubAppFetch = (input, init) => {
			requests.push(input instanceof Request ? input.url : input.toString())
			if (!(init?.signal instanceof AbortSignal)) throw new Error('expected token request signal')
			started.resolve(init.signal)
			return response.promise
		}
		return { fetch, requests, started: started.promise, response }
	}

	test('uses only the recorded installation, canonical repository scope, and read-only token for resolution and clone', async () => {
		const http = sourceHttpStub([tokenResponse(), sourceCommitResponse(), tokenResponse()])
		const source = publicSource(http.fetch, credentials)
		const caller = new AbortController()
		expect(await source.resolveCommit(`${SOURCE_REPO}.git`, 'main', 73, caller.signal)).toEqual({ commitSha: SOURCE_COMMIT })
		const target = await source.clone(SOURCE_REPO, SOURCE_COMMIT, 73, caller.signal)
		expect(target).toEqual({ cloneUrl: 'https://x-access-token:test-installation-token@github.com/acme/app', ref: SOURCE_COMMIT })
		const mintRequests = http.requests.filter((request) => request.method === 'POST')
		expect(mintRequests).toHaveLength(2)
		for (const request of mintRequests) {
			expect(request.url).toBe('https://api.github.com/app/installations/73/access_tokens')
			expect(request.body).toBe(JSON.stringify({ repositories: ['app'], permissions: { contents: 'read' } }))
			expect(request.headers.get('authorization')).toStartWith('Bearer ')
			expect(request.redirect).toBe('error')
			expectNoAbortListeners(request.signal)
		}
		for (const request of http.requests.filter((request) => request.method !== 'POST')) {
			expect(request.url).toStartWith(COMMITS_URL)
			expect(request.url).not.toContain('test-installation-token')
			expect(request.headers.get('authorization')).toBe('Bearer test-installation-token')
		}
		expectNoAbortListeners(caller.signal)
	})

	test.each([401, 403, 404, 500])('does not try anonymous access after token mint HTTP %s', async (status) => {
		for (const clone of [false, true]) {
			const http = sourceHttpStub([new Response('credential in upstream body', { status })])
			const source = publicSource(http.fetch, credentials)
			const caller = new AbortController()
			const pending = clone
				? source.clone(SOURCE_REPO, SOURCE_COMMIT, 73, caller.signal)
				: source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, 73, caller.signal)
			await expect(pending).rejects.toThrow('GitHub source authorization failed')
			expect(http.requests).toHaveLength(1)
			expectNoAbortListeners(http.requests[0]?.signal)
			expectNoAbortListeners(caller.signal)
		}
	})

	test('does not fall back after an authorized commit request fails', async () => {
		const http = sourceHttpStub([tokenResponse(), new Response('test-installation-token', { status: 403 })])
		await expect(publicSource(http.fetch, credentials).resolveCommit(SOURCE_REPO, 'main', 73)).rejects.toMatchObject({
			code: 'internal',
			stage: 'resolve',
		})
		expect(http.requests).toHaveLength(2)
		expect(http.requests[1]?.headers.get('authorization')).toBe('Bearer test-installation-token')
	})

	test('refuses malformed or expired token responses without anonymous access', async () => {
		for (const clone of [false, true]) {
			for (const body of ['private invalid JSON', '{}', JSON.stringify({ token: 'private-token', expires_at: '2000-01-01T00:00:00Z' })]) {
				const http = sourceHttpStub([new Response(body)])
				const source = publicSource(http.fetch, credentials)
				const pending = clone ? source.clone(SOURCE_REPO, SOURCE_COMMIT, 73) : source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, 73)
				const error = await pending.catch((error: unknown) => error)
				expect(error instanceof Error ? error.message : '').toBe('GitHub source authorization failed')
				expect(http.requests).toHaveLength(1)
			}
		}
	})

	test('bounds stalled private token bodies for resolution and clone without anonymous fallback', async () => {
		for (const clone of [false, true]) {
			let cancelled = false
			const http = sourceHttpStub([
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"token":'))
						},
						cancel() {
							cancelled = true
						},
					}),
				),
			])
			const source = publicSource(http.fetch, { ...credentials, timeoutMs: 10 })
			const pending = clone ? source.clone(SOURCE_REPO, SOURCE_COMMIT, 73) : source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, 73)
			await expect(pending).rejects.toThrow('GitHub source authorization failed')
			expect(cancelled).toBe(true)
			expect(http.requests).toHaveLength(1)
			expectNoAbortListeners(http.requests[0]?.signal)
		}
	})

	test.each(['timeout', 'lease_lost', 'cancel_requested'])(
		'disposes a late private token body after %s without reading it',
		async (kind: 'timeout' | 'lease_lost' | 'cancel_requested') => {
			for (const clone of [false, true]) {
				const http = pendingTokenHttpStub()
				const source = publicSource(http.fetch, { ...credentials, timeoutMs: 50 })
				const controller = new AbortController()
				const pending = clone
					? source.clone(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
					: source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
				const settled = pending.catch((error: unknown) => error)
				const requestSignal = await http.started
				if (kind === 'timeout') {
					const error = await settled
					expect(error instanceof Error ? error.message : '').toBe('GitHub source authorization failed')
				} else {
					const reason = new ProviderInvocationAbort(kind)
					controller.abort(reason)
					expect(await settled).toBe(reason)
				}
				expect(requestSignal.aborted).toBe(true)
				let read = false
				let cancelled = false
				const lateResponse = new Response(
					new ReadableStream<Uint8Array>({
						pull() {
							read = true
						},
						cancel() {
							cancelled = true
							return new Promise<void>(() => {})
						},
					}, { highWaterMark: 0 }),
				)
				http.response.resolve(lateResponse)
				await http.response.promise
				await Promise.resolve()
				expect(cancelled).toBe(true)
				expect(read).toBe(false)
				expect(http.requests).toEqual(['https://api.github.com/app/installations/73/access_tokens'])
				expectNoAbortListeners(requestSignal)
				expectNoAbortListeners(controller.signal)
			}
		},
	)

	test.each(['lease_lost', 'cancel_requested'])(
		'cancels an unread token body on queued %s during the SDK response handoff',
		async (kind: 'lease_lost' | 'cancel_requested') => {
			for (const clone of [false, true]) {
				const http = pendingTokenHttpStub()
				const source = publicSource(http.fetch, credentials)
				const controller = new AbortController()
				const reason = new ProviderInvocationAbort(kind)
				const pending = clone
					? source.clone(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
					: source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
				const settled = pending.catch((error: unknown) => error)
				const requestSignal = await http.started
				let read = false
				let cancelled = false
				http.response.resolve(
					new Response(
						new ReadableStream<Uint8Array>({
							pull() {
								read = true
							},
							cancel() {
								cancelled = true
								return Promise.reject(new Error('private body cancellation failure'))
							},
						}, { highWaterMark: 0 }),
					),
				)
				queueMicrotask(() => controller.abort(reason))
				expect(await settled).toBe(reason)
				expect(requestSignal.aborted).toBe(true)
				expect(cancelled).toBe(true)
				expect(read).toBe(false)
				expect(http.requests).toEqual(['https://api.github.com/app/installations/73/access_tokens'])
				expectNoAbortListeners(requestSignal)
				expectNoAbortListeners(controller.signal)
			}
		},
	)

	test.each(['lease_lost', 'cancel_requested'])(
		'preserves exact %s against an uncooperative private token fetch',
		async (kind: 'lease_lost' | 'cancel_requested') => {
			for (const clone of [false, true]) {
				const http = pendingTokenHttpStub()
				const source = publicSource(http.fetch, credentials)
				const controller = new AbortController()
				const reason = new ProviderInvocationAbort(kind)
				const pending = clone
					? source.clone(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
					: source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
				const settled = pending.catch((error: unknown) => error)
				const requestSignal = await http.started
				controller.abort(reason)
				expect(await settled).toBe(reason)
				expect(requestSignal.aborted).toBe(true)
				http.response.reject(new Error('late private transport rejection'))
				await http.response.promise.catch(() => {})
				await Promise.resolve()
				expect(http.requests).toEqual(['https://api.github.com/app/installations/73/access_tokens'])
				expectNoAbortListeners(requestSignal)
				expectNoAbortListeners(controller.signal)
			}
		},
	)

	test.each([0, -1, 1.5, Number.NaN])('refuses invalid private installation %s without HTTP', async (installationId) => {
		const http = sourceHttpStub([])
		await expect(publicSource(http.fetch, credentials).resolveCommit(SOURCE_REPO, SOURCE_COMMIT, installationId)).rejects.toThrow(
			'GitHub source authorization failed',
		)
		expect(http.requests).toHaveLength(0)
	})

	test('redacts rejected client creation and rejected token transport on both deployment paths', async () => {
		for (const clone of [false, true]) {
			let requests = 0
			for (const config of [{ appId: '1', privateKeyPem: 'private-invalid-key' }, credentials]) {
				const source = publicSource(() => {
					requests += 1
					return Promise.reject(new Error('credential in transport failure'))
				}, config)
				const pending = clone ? source.clone(SOURCE_REPO, SOURCE_COMMIT, 73) : source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, 73)
				await expect(pending).rejects.toThrow('GitHub source authorization failed')
			}
			expect(requests).toBe(1)
		}
	})

	test('preserves exact cancellation when client creation rejects', async () => {
		for (const clone of [false, true]) {
			const http = sourceHttpStub([])
			const source = publicSource(http.fetch, { appId: '1', privateKeyPem: 'invalid-key' })
			const controller = new AbortController()
			const reason = new ProviderInvocationAbort('lease_lost')
			const pending = clone
				? source.clone(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
				: source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
			controller.abort(reason)
			expect(await pending.catch((error: unknown) => error)).toBe(reason)
			expect(http.requests).toHaveLength(0)
		}
	})

	test('restores original cancellation on rejected private token minting for resolution and clone', async () => {
		for (const clone of [false, true]) {
			const controller = new AbortController()
			const reason = new ProviderInvocationAbort('cancel_requested')
			const started = Promise.withResolvers<void>()
			let requests = 0
			const source = publicSource((_url, init) => {
				requests += 1
				const signal = init?.signal
				if (!(signal instanceof AbortSignal)) throw new Error('expected caller-linked signal')
				started.resolve()
				return new Promise<Response>((_resolve, reject) =>
					signal.addEventListener('abort', () => reject(new Error('private transport reason')), { once: true })
				)
			}, credentials)
			const pending = clone
				? source.clone(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
				: source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, 73, controller.signal)
			await started.promise
			controller.abort(reason)
			expect(await pending.catch((error: unknown) => error)).toBe(reason)
			expect(requests).toBe(1)
		}
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
