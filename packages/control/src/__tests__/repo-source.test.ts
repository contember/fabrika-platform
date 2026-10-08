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
const OTHER_COMMIT = 'b'.repeat(40)
const TAG_OBJECT = 'c'.repeat(40)
const NESTED_TAG_OBJECT = 'd'.repeat(40)
const SOURCE_REPO = 'github.com/acme/app'
const GIT_DATA_URL = 'https://api.github.com/repos/acme/app/git/'
const sourceCommitResponse = (sha = SOURCE_COMMIT): Response => Response.json({ sha })
const sourceRefResponse = (ref: string, sha = SOURCE_COMMIT, type = 'commit'): Response => Response.json({ ref, object: { type, sha } })
const sourceTagResponse = (sha: string, target = SOURCE_COMMIT, type = 'commit'): Response => Response.json({ sha, object: { type, sha: target } })

describe('GitHubAppRepoSource.resolveCommit (native HTTP stubs, not live GitHub)', () => {
	test.each([undefined, null])('resolves public refs without constructing an App client (installation %s)', async (installationId) => {
		const http = sourceHttpStub([sourceRefResponse('refs/heads/main'), sourceCommitResponse()])
		expect(await publicSource(http.fetch).resolveCommit(`${SOURCE_REPO}.git`, 'refs/heads/main', installationId)).toEqual({ commitSha: SOURCE_COMMIT })
		expect(http.requests.map((request) => request.url)).toEqual([`${GIT_DATA_URL}ref/heads/main`, `${GIT_DATA_URL}commits/${SOURCE_COMMIT}`])
		for (const request of http.requests) {
			expect(request.headers.has('authorization')).toBe(false)
			expect(request.headers.get('accept')).toBe('application/vnd.github+json')
			expect(request.headers.get('x-github-api-version')).toBe('2022-11-28')
			expect(request.redirect).toBe('error')
			expect(request.signal).toBeInstanceOf(AbortSignal)
		}
	})

	test('verifies a recorded complete SHA directly, normalizing case without looking up a mutable ref', async () => {
		const http = sourceHttpStub([sourceCommitResponse(SOURCE_COMMIT.toUpperCase())])
		expect(await publicSource(http.fetch).resolveCommit(SOURCE_REPO, SOURCE_COMMIT.toUpperCase())).toEqual({ commitSha: SOURCE_COMMIT })
		expect(http.requests.map((request) => request.url)).toEqual([`${GIT_DATA_URL}commits/${SOURCE_COMMIT}`])
	})

	test('rejects a missing recorded non-commit object without peeling or ref fallback', async () => {
		const http = sourceHttpStub([new Response('private response body', { status: 404 })])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, TAG_OBJECT)).rejects.toThrow('GitHub source request failed')
		expect(http.requests.map((request) => request.url)).toEqual([`${GIT_DATA_URL}commits/${TAG_OBJECT}`])
	})

	test.each([{}, null, [], { sha: OTHER_COMMIT }, { sha: 'abc' }, { sha: 'a'.repeat(64) }, { sha: 3 }].map((body) => ({ body })))(
		'rejects invalid commit identity %j',
		async ({ body }) => {
			const http = sourceHttpStub([Response.json(body)])
			await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, SOURCE_COMMIT)).rejects.toThrow('GitHub source response is invalid')
			expect(http.requests).toHaveLength(1)
		},
	)

	test.each(['heads', 'tags'])('keeps the qualified %s namespace for a shared short name', async (namespace) => {
		const ref = `refs/${namespace}/shared`
		const http = sourceHttpStub([sourceRefResponse(ref), sourceCommitResponse()])
		expect(await publicSource(http.fetch).resolveCommit(SOURCE_REPO, ref)).toEqual({ commitSha: SOURCE_COMMIT })
		expect(http.requests[0]?.url).toBe(`${GIT_DATA_URL}ref/${namespace}/shared`)
	})

	test('bare names select the exact branch first without consulting a same-name tag', async () => {
		const http = sourceHttpStub([sourceRefResponse('refs/heads/shared'), sourceCommitResponse()])
		expect(await publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'shared')).toEqual({ commitSha: SOURCE_COMMIT })
		expect(http.requests.map((request) => request.url)).toEqual([`${GIT_DATA_URL}ref/heads/shared`, `${GIT_DATA_URL}commits/${SOURCE_COMMIT}`])
	})

	test('only a bare-name heads 404 permits exact tag fallback', async () => {
		const http = sourceHttpStub([new Response('not JSON', { status: 404 }), sourceRefResponse('refs/tags/v1'), sourceCommitResponse()])
		expect(await publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'v1')).toEqual({ commitSha: SOURCE_COMMIT })
		expect(http.requests.map((request) => request.url)).toEqual([
			`${GIT_DATA_URL}ref/heads/v1`,
			`${GIT_DATA_URL}ref/tags/v1`,
			`${GIT_DATA_URL}commits/${SOURCE_COMMIT}`,
		])
	})

	test.each([401, 403, 422, 429, 500, 302])('does not fall back from a bare head on HTTP %s', async (status) => {
		const http = sourceHttpStub([new Response('private body', { status })])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'v1')).rejects.toThrow('GitHub source request failed')
		expect(http.requests).toHaveLength(1)
	})

	test.each(['refs/heads/missing', 'refs/tags/missing'])('qualified 404 does not consult another namespace: %s', async (ref) => {
		const http = sourceHttpStub([new Response(null, { status: 404 })])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, ref)).rejects.toThrow('GitHub source request failed')
		expect(http.requests).toHaveLength(1)
	})

	test.each([
		{},
		[],
		{ ref: 'refs/heads/main-other', object: { type: 'commit', sha: SOURCE_COMMIT } },
		{ ref: 'refs/tags/main', object: { type: 'commit', sha: SOURCE_COMMIT } },
		{ ref: 'refs/heads/main', object: { type: 'tag', sha: TAG_OBJECT } },
		{ ref: 'refs/heads/main', object: { type: 'tree', sha: TAG_OBJECT } },
		{ ref: 'refs/heads/main', object: { type: 'commit', sha: 'abc' } },
		{ ref: 'refs/heads/main', object: { sha: SOURCE_COMMIT } },
	].map((body) => ({ body })))('binds a head response to its exact ref and typed object: %j', async ({ body }) => {
		const http = sourceHttpStub([Response.json(body)])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'main')).rejects.toThrow('GitHub source response is invalid')
		expect(http.requests).toHaveLength(1)
	})

	test('encodes untrusted ref path components and treats abbreviated IDs as exact names', async () => {
		for (const name of ['features/a#b%é😀]x', 'abc1234']) {
			const http = sourceHttpStub([sourceRefResponse(`refs/heads/${name}`), sourceCommitResponse()])
			expect(await publicSource(http.fetch).resolveCommit(SOURCE_REPO, name)).toEqual({ commitSha: SOURCE_COMMIT })
			expect(http.requests[0]?.url).toBe(`${GIT_DATA_URL}ref/heads/${name.split('/').map(encodeURIComponent).join('/')}`)
		}
	})

	test('allows intermediate trailing dots in bare, qualified head and qualified tag names', async () => {
		for (const ref of ['topic./part', 'refs/heads/topic./part', 'refs/tags/topic./part']) {
			const expectedRef = ref === 'topic./part' ? 'refs/heads/topic./part' : ref
			const http = sourceHttpStub([sourceRefResponse(expectedRef), sourceCommitResponse()])
			expect(await publicSource(http.fetch).resolveCommit(SOURCE_REPO, ref)).toEqual({ commitSha: SOURCE_COMMIT })
			expect(http.requests.map((request) => request.url)).toEqual([
				`${GIT_DATA_URL}ref/${expectedRef.slice('refs/'.length)}`,
				`${GIT_DATA_URL}commits/${SOURCE_COMMIT}`,
			])
		}
	})

	test.each([
		'',
		'-main',
		'refs/heads/-main',
		'refs/heads/',
		'refs/tags/',
		'refs/pull/1/head',
		'refs/notes/main',
		'main~1',
		'HEAD^{commit}',
		'main@{1}',
		'v*',
		'a?b',
		'a[b',
		'a\\b',
		'a:b',
		'a b',
		'a\nb',
		'a\0b',
		'a\u007fb',
		'a\u0085b',
		'a\u2028b',
		'a\ud800b',
		'../main',
		'.hidden',
		'a..b',
		'a//b',
		'a/.b',
		'a.lock',
		'a/b.lock',
		'a/',
		'/a',
		'a.',
		'@',
		'a'.repeat(1025),
	])('refuses unsafe or non-concrete refs before HTTP: %j', async (ref) => {
		const http = sourceHttpStub([])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, ref, 7)).rejects.toThrow('invalid GitHub source ref')
		expect(http.requests).toHaveLength(0)
	})

	test('explicitly refuses a complete SHA-256 input', async () => {
		const http = sourceHttpStub([])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'a'.repeat(64))).rejects.toThrow('does not support 64-hex commit IDs')
		expect(http.requests).toHaveLength(0)
	})

	test.each(['https://github.com/acme/app', 'github.com/acme/app?secret', 'github.com/acme/app/extra', 'github.com/../app', 'gitlab.com/acme/app'])(
		'refuses noncanonical repository %s',
		async (repo) => {
			const http = sourceHttpStub([])
			await expect(publicSource(http.fetch).resolveCommit(repo, SOURCE_COMMIT, 7)).rejects.toThrow('invalid canonical GitHub repository')
			expect(http.requests).toHaveLength(0)
		},
	)

	test('peels nested annotated tags and verifies the final commit independently', async () => {
		const http = sourceHttpStub([
			sourceRefResponse('refs/tags/v1', TAG_OBJECT.toUpperCase(), 'tag'),
			sourceTagResponse(TAG_OBJECT.toUpperCase(), NESTED_TAG_OBJECT, 'tag'),
			sourceTagResponse(NESTED_TAG_OBJECT),
			sourceCommitResponse(),
		])
		expect(await publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'refs/tags/v1')).toEqual({ commitSha: SOURCE_COMMIT })
		expect(http.requests.map((request) => request.url)).toEqual([
			`${GIT_DATA_URL}ref/tags/v1`,
			`${GIT_DATA_URL}tags/${TAG_OBJECT}`,
			`${GIT_DATA_URL}tags/${NESTED_TAG_OBJECT}`,
			`${GIT_DATA_URL}commits/${SOURCE_COMMIT}`,
		])
	})

	test.each(['tree', 'blob', 'unknown'])('refuses non-commit terminal tag object %s', async (type) => {
		for (
			const responses of [
				[sourceRefResponse('refs/tags/v1', TAG_OBJECT, type)],
				[sourceRefResponse('refs/tags/v1', TAG_OBJECT, 'tag'), sourceTagResponse(TAG_OBJECT, SOURCE_COMMIT, type)],
			]
		) {
			const http = sourceHttpStub(responses)
			await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'refs/tags/v1')).rejects.toThrow('GitHub source response is invalid')
			expect(http.requests.some((request) => request.url.includes('/commits/'))).toBe(false)
		}
	})

	test.each([
		{ sha: NESTED_TAG_OBJECT, object: { type: 'commit', sha: SOURCE_COMMIT } },
		{ sha: TAG_OBJECT },
		{ sha: TAG_OBJECT, object: { type: 'commit', sha: 'bad' } },
		{ sha: TAG_OBJECT, object: { sha: SOURCE_COMMIT } },
	])('binds annotated tag identity and target: %j', async (body) => {
		const http = sourceHttpStub([sourceRefResponse('refs/tags/v1', TAG_OBJECT, 'tag'), Response.json(body)])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'refs/tags/v1')).rejects.toThrow('GitHub source response is invalid')
		expect(http.requests).toHaveLength(2)
	})

	test('refuses annotated tag cycles before repeating an object request', async () => {
		const http = sourceHttpStub([
			sourceRefResponse('refs/tags/v1', TAG_OBJECT, 'tag'),
			sourceTagResponse(TAG_OBJECT, NESTED_TAG_OBJECT, 'tag'),
			sourceTagResponse(NESTED_TAG_OBJECT, TAG_OBJECT.toUpperCase(), 'tag'),
		])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'refs/tags/v1')).rejects.toThrow('GitHub source response is invalid')
		expect(http.requests).toHaveLength(3)
	})

	test.each([8, 9])('annotated tag peeling is bounded at eight objects (chain %s)', async (count) => {
		const ids = Array.from({ length: count }, (_, index) => index.toString(16).padStart(40, '0'))
		const responses = [sourceRefResponse('refs/tags/v1', ids[0], 'tag')]
		for (const [index, id] of ids.entries()) {
			const next = ids[index + 1]
			responses.push(sourceTagResponse(id, next ?? SOURCE_COMMIT, next === undefined ? 'commit' : 'tag'))
		}
		responses.push(sourceCommitResponse())
		const http = sourceHttpStub(responses)
		const pending = publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'refs/tags/v1')
		if (count === 8) {
			expect(await pending).toEqual({ commitSha: SOURCE_COMMIT })
			expect(http.requests).toHaveLength(10)
		} else {
			await expect(pending).rejects.toThrow('GitHub source response is invalid')
			expect(http.requests).toHaveLength(9)
		}
	})

	test('verifies a lightweight or peeled commit instead of trusting the tag response', async () => {
		for (
			const initial of [
				[sourceRefResponse('refs/tags/v1')],
				[sourceRefResponse('refs/tags/v1', TAG_OBJECT, 'tag'), sourceTagResponse(TAG_OBJECT)],
			]
		) {
			const http = sourceHttpStub([...initial, sourceCommitResponse(OTHER_COMMIT)])
			await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, 'refs/tags/v1')).rejects.toThrow('GitHub source response is invalid')
			expect(http.requests.at(-1)?.url).toBe(`${GIT_DATA_URL}commits/${SOURCE_COMMIT}`)
		}
	})

	test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 120001])('validates the reused timeout seam before HTTP (%s)', async (timeoutMs) => {
		const http = sourceHttpStub([])
		await expect(publicSource(http.fetch, { timeoutMs }).resolveCommit(SOURCE_REPO, SOURCE_COMMIT)).rejects.toThrow(
			'GitHub source configuration is invalid',
		)
		expect(http.requests).toHaveLength(0)
	})

	test('accepts the maximum timeout and the existing HTTPS API-base override', async () => {
		const http = sourceHttpStub([sourceCommitResponse()])
		expect(await publicSource(http.fetch, { timeoutMs: 120000, apiBaseUrl: 'https://github.test/api/v3/' }).resolveCommit(SOURCE_REPO, SOURCE_COMMIT))
			.toEqual({ commitSha: SOURCE_COMMIT })
		expect(http.requests[0]?.url).toBe(`https://github.test/api/v3/repos/acme/app/git/commits/${SOURCE_COMMIT}`)
	})

	test.each(['http://github.test', 'https://token@github.test', 'https://github.test?token', 'https://github.test#token', 'not a URL'])(
		'refuses unsafe API-base configuration: %s',
		async (apiBaseUrl) => {
			const http = sourceHttpStub([])
			await expect(publicSource(http.fetch, { apiBaseUrl }).resolveCommit(SOURCE_REPO, SOURCE_COMMIT)).rejects.toThrow(
				'GitHub source configuration is invalid',
			)
			expect(http.requests).toHaveLength(0)
		},
	)

	test.each(['not JSON with a private token', '', '{"sha":'])('refuses malformed JSON without including its body: %s', async (body) => {
		const http = sourceHttpStub([new Response(body)])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, SOURCE_COMMIT)).rejects.toThrow('GitHub source request failed')
	})

	test('refuses invalid UTF-8 and redacts body-reader exceptions', async () => {
		for (
			const body of [
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([0xff]))
						controller.close()
					},
				}),
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.error(new Error('token in stream failure'))
					},
				}),
			]
		) {
			const http = sourceHttpStub([new Response(body)])
			await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, SOURCE_COMMIT)).rejects.toThrow('GitHub source request failed')
		}
	})

	test('enforces the 64 KiB bound on declared and streamed bytes and cancels failed bodies', async () => {
		for (const declared of [true, false]) {
			let cancelled = false
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(32 * 1024))
					controller.enqueue(new Uint8Array(32 * 1024 + 1))
				},
				cancel() {
					cancelled = true
				},
			})
			const http = sourceHttpStub([new Response(stream, { headers: { 'content-length': declared ? '65537' : '1' } })])
			await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, SOURCE_COMMIT)).rejects.toThrow('GitHub source request failed')
			expect(cancelled).toBe(true)
		}
	})

	test('accepts a valid exactly-64-KiB response assembled from chunks', async () => {
		const json = JSON.stringify({ sha: SOURCE_COMMIT })
		const bytes = new TextEncoder().encode(json.padEnd(64 * 1024, ' '))
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, 10))
				controller.enqueue(bytes.slice(10))
				controller.close()
			},
		})
		const http = sourceHttpStub([new Response(stream)])
		expect(await publicSource(http.fetch).resolveCommit(SOURCE_REPO, SOURCE_COMMIT)).toEqual({ commitSha: SOURCE_COMMIT })
	})

	test('bounds a fetch which ignores abort and redacts ordinary transport errors', async () => {
		const timedOut = await publicSource(() => new Promise<Response>(() => {}), { timeoutMs: 10 }).resolveCommit(SOURCE_REPO, SOURCE_COMMIT).catch((
			error: unknown,
		) => error)
		expect(timedOut).toBeInstanceOf(DOMException)
		expect(timedOut instanceof Error ? timedOut.name : '').toBe('TimeoutError')
		const failure = await publicSource(() => Promise.reject(new Error('https://token@github.com/private'))).resolveCommit(SOURCE_REPO, 'main').catch((
			error: unknown,
		) => error)
		expect(failure instanceof Error ? failure.message : '').toBe('GitHub source request failed')
	})

	test('preserves cancellation while fetch ignores abort and closes a late response', async () => {
		const controller = new AbortController()
		const reason = new ProviderInvocationAbort('lease_lost')
		const response = Promise.withResolvers<Response>()
		let cancelled = false
		const source = publicSource(() => response.promise)
		const pending = source.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, null, controller.signal)
		controller.abort(reason)
		expect(await pending.catch((error: unknown) => error)).toBe(reason)
		response.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true
					},
				}),
			),
		)
		await response.promise
		expect(cancelled).toBe(true)
	})

	test('refuses a redirected success response before parsing its commit', async () => {
		class RedirectedResponse extends Response {
			override get redirected(): boolean {
				return true
			}
		}
		const http = sourceHttpStub([new RedirectedResponse(JSON.stringify({ sha: SOURCE_COMMIT }))])
		await expect(publicSource(http.fetch).resolveCommit(SOURCE_REPO, SOURCE_COMMIT)).rejects.toThrow('GitHub source request failed')
		expect(http.requests).toHaveLength(1)
	})

	test('keeps the request deadline active through a stalled body read, including stalled cancellation', async () => {
		let cancelled = false
		const http = sourceHttpStub([
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"sha":'))
					},
					cancel() {
						cancelled = true
						return new Promise<void>(() => {})
					},
				}),
			),
		])
		const error = await publicSource(http.fetch, { timeoutMs: 10 }).resolveCommit(SOURCE_REPO, SOURCE_COMMIT).catch((error: unknown) => error)
		expect(error).toBeInstanceOf(DOMException)
		expect(error instanceof Error ? error.name : '').toBe('TimeoutError')
		expect(cancelled).toBe(true)
		expect(http.requests[0]?.signal?.aborted).toBe(true)
	})

	test.each(['lease_lost', 'cancel_requested'])('preserves exact %s identity during body reads', async (kind: 'lease_lost' | 'cancel_requested') => {
		const controller = new AbortController()
		const reason = new ProviderInvocationAbort(kind)
		const started = Promise.withResolvers<void>()
		let cancelled = false
		const http = sourceHttpStub([
			new Response(
				new ReadableStream<Uint8Array>({
					pull() {
						started.resolve()
					},
					cancel() {
						cancelled = true
					},
				}, { highWaterMark: 0 }),
			),
		])
		const pending = publicSource(http.fetch).resolveCommit(SOURCE_REPO, SOURCE_COMMIT, null, controller.signal)
		await started.promise
		controller.abort(reason)
		expect(await pending.catch((error: unknown) => error)).toBe(reason)
		expect(cancelled).toBe(true)
	})

	test('checks caller cancellation before public access and after HTTP completion', async () => {
		const controller = new AbortController()
		const reason = new ProviderInvocationAbort('lease_lost')
		const http = sourceHttpStub([])
		controller.abort(reason)
		expect(await publicSource(http.fetch).resolveCommit(SOURCE_REPO, SOURCE_COMMIT, null, controller.signal).catch((error: unknown) => error)).toBe(
			reason,
		)
		expect(http.requests).toHaveLength(0)
		const late = new AbortController()
		const lateSource = publicSource(() => {
			late.abort(reason)
			return Promise.resolve(sourceCommitResponse())
		})
		expect(await lateSource.resolveCommit(SOURCE_REPO, SOURCE_COMMIT, null, late.signal).catch((error: unknown) => error)).toBe(reason)
	})
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
		const http = sourceHttpStub([tokenResponse(), sourceRefResponse('refs/heads/main'), sourceCommitResponse(), tokenResponse()])
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
			expect(request.url).toStartWith(GIT_DATA_URL)
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

	test('does not fall back after an authorized Git-data request fails', async () => {
		const http = sourceHttpStub([tokenResponse(), new Response('test-installation-token', { status: 403 })])
		await expect(publicSource(http.fetch, credentials).resolveCommit(SOURCE_REPO, 'main', 73)).rejects.toThrow('GitHub source request failed')
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
