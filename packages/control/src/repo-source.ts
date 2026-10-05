// The RepoSource abstraction — how the control plane gets a clonable URL for a repo+ref and verifies
// inbound webhooks. Decoupled behind an interface so the queue consumer and webhook handler stay
// testable with a FakeRepoSource (no GitHub, no network), and so a future public-repo direct-clone or
// polling source can slot in.
//
// PUBLIC-REPO DIRECT-CLONE: a public repo needs no token (the clone URL is the repo URL), so
// `clone()` returns the bare URL when no installation id is given. Public repos have no webhook, so
// their deploy trigger is PULLED instead: see `src/repo-poll.ts` (a cron-driven Atom-feed poller), wired
// in `src/index.ts` `scheduled`. Polling lives there (standalone — no webhook HMAC applies to a public
// feed), not as a `RepoSource` method; this interface stays focused on clone + webhook verification.

import { GitHubAppClient, type GitHubAppClientConfig, type GitHubAppFetch, pemToPkcs8 } from '@fabrika/github-app'
import { prop, stringField } from './json'

export { pemToPkcs8 }

export const GITHUB_WEBHOOK_MAX_BYTES = 1024 * 1024

/** The decoded, verified payload of a GitHub `push` webhook (only the fields we use). */
export interface PushEvent {
	/** The pushed git ref, e.g. `refs/heads/deploy/prod`. */
	ref: string
	/** The repo's clone URL (https), used to identify which app this push belongs to. */
	repoUrl: string
	/** The head commit sha after the push, when present. */
	commitSha: string | null
	/** The GitHub App installation id that delivered this event, when present. */
	installationId: number | null
}

/** A clonable git URL plus the ref to check out — what the runner job needs. */
export interface CloneTarget {
	/** The URL to `git clone` (may embed a short-lived token for private repos). */
	cloneUrl: string
	/** The ref to check out after cloning. */
	ref: string
}

/**
 * How the control plane sources a repo. v1 is `GitHubAppRepoSource`; tests use `FakeRepoSource`.
 *  - `clone(repoUrl, ref, installationId?)` → a clonable URL (mints a short-lived token for the
 *    install when one is given; otherwise returns the bare URL for a public repo).
 *  - `verifyWebhook(req)` → the decoded `PushEvent` iff the HMAC signature checks out, else null.
 */
export interface RepoEvents {
	verifyWebhook(request: Request): Promise<PushEvent | null>
	/**
	 * Resolve the GitHub App installation id that grants access to `repoUrl` (so onboarding a private
	 * repo can auto-fill it instead of pasting the number by hand). Returns null when the App isn't
	 * installed on the repo, the host isn't GitHub, or the lookup fails. Caller cancellation remains an
	 * AbortError; an ordinary miss must not fail app creation because the operator can set it manually.
	 */
	resolveInstallationId(repoUrl: string, signal?: AbortSignal): Promise<number | null>
}

export interface RepoSource extends RepoEvents {
	clone(repoUrl: string, ref: string, installationId?: number | null, signal?: AbortSignal): Promise<CloneTarget>
}

export interface RepoInstallationLookup {
	resolveInstallationId(repoUrl: string, signal?: AbortSignal): Promise<number | null>
}

/** Supplies the current webhook HMAC secret without exposing it through connection state. */
export interface WebhookSecretProvider {
	getSecret(signal?: AbortSignal): Promise<string | null>
}

export class StaticWebhookSecretProvider implements WebhookSecretProvider {
	constructor(private readonly value: string | undefined) {}

	getSecret(signal?: AbortSignal): Promise<string | null> {
		if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
		return Promise.resolve(this.value === undefined || this.value === '' ? null : this.value)
	}
}

// ── HMAC-SHA256 webhook signature verification (shared by real + fake) ─────────

/**
 * Verify a GitHub `X-Hub-Signature-256` header (`sha256=<hex>`) over the raw body using the webhook
 * secret. Constant-time compare via WebCrypto's `verify` (no manual string compare). Returns the raw
 * body string on success so the caller parses it once. `null` on any mismatch / malformed header.
 */
export async function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> {
	if (secret === '' || signatureHeader === null || !signatureHeader.startsWith('sha256=')) {
		return false
	}
	const provided = hexToBytes(signatureHeader.slice('sha256='.length))
	if (provided === null) {
		return false
	}
	const key = await crypto.subtle.importKey(
		'raw',
		utf8(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	)
	// `crypto.subtle.verify` does the constant-time comparison internally.
	return crypto.subtle.verify('HMAC', key, provided, utf8(rawBody))
}

/** Keep webhook authentication local while delegating installation ownership to the source service. */
export class LocalGitHubRepoEvents implements RepoEvents {
	private readonly webhookSecrets: WebhookSecretProvider

	constructor(
		webhookSecret: string | undefined | WebhookSecretProvider,
		private readonly installations: RepoInstallationLookup,
	) {
		this.webhookSecrets = typeof webhookSecret === 'object' ? webhookSecret : new StaticWebhookSecretProvider(webhookSecret)
	}

	resolveInstallationId(repoUrl: string, signal?: AbortSignal): Promise<number | null> {
		return this.installations.resolveInstallationId(repoUrl, signal)
	}

	async verifyWebhook(request: Request): Promise<PushEvent | null> {
		const secret = await this.webhookSecrets.getSecret(request.signal)
		if (secret === null || secret === '') return null
		return verifyPushWebhook(request, secret)
	}
}

/**
 * UTF-8 encode a string into an `ArrayBuffer`-backed view. `TextEncoder().encode` is typed
 * `Uint8Array<ArrayBufferLike>`, which doesn't satisfy WebCrypto's `BufferSource` (ArrayBuffer-backed)
 * under the workers-types lib. Copying into a fresh `ArrayBuffer` fixes the type without a cast.
 */
function utf8(text: string): Uint8Array<ArrayBuffer> {
	const encoded = new TextEncoder().encode(text)
	const buffer = new ArrayBuffer(encoded.byteLength)
	const view = new Uint8Array(buffer)
	view.set(encoded)
	return view
}

/** Parse an even-length hex string to bytes; null on any non-hex / odd length. */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[0-9a-f]{64}$/i.test(hex)) {
		return null
	}
	const out = new Uint8Array(hex.length / 2)
	for (let i = 0; i < out.length; i++) {
		const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
		if (Number.isNaN(byte)) {
			return null
		}
		out[i] = byte
	}
	return out
}

/**
 * Normalize a git repo URL for matching a push against a registered app. Lowercases the host, drops a
 * trailing `.git` and trailing slash, and ignores `https://` vs `git@`/`ssh` differences by reducing
 * to `host/owner/repo`. So `https://github.com/acme/App.git` and `git@github.com:acme/App` match the
 * registered `https://github.com/acme/App`. Same function applied to both sides at write + match time.
 */
export function normalizeRepoUrl(repoUrl: string): string {
	let s = repoUrl.trim()
	// scp-like syntax: git@host:owner/repo → host/owner/repo
	const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(s)
	if (scp) {
		s = `${scp[1]}/${scp[2]}`
	} else {
		// Drop the scheme (https://, ssh://, …) and any leading userinfo (git@…) it carried.
		s = s.replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]+@/, '')
	}
	s = s.replace(/\/+$/, '').replace(/\.git$/i, '')
	const slash = s.indexOf('/')
	if (slash !== -1) {
		s = s.slice(0, slash).toLowerCase() + s.slice(slash)
	}
	return s
}

/**
 * Extract `{ owner, repo }` from a GitHub repo URL (any form `normalizeRepoUrl` accepts). Returns null
 * for a non-github.com host or a path that isn't `owner/repo` — the caller then can't resolve an
 * installation. Owner/repo case is preserved (the GitHub API is case-insensitive on them anyway).
 */
export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
	const [host, owner, repo, ...rest] = normalizeRepoUrl(repoUrl).split('/')
	if (host !== 'github.com' || owner === undefined || owner === '' || repo === undefined || repo === '' || rest.length > 0) {
		return null
	}
	return { owner, repo }
}

/** Decode a verified GitHub push payload into our `PushEvent` (structural, no casts). */
export function decodePushEvent(body: unknown): PushEvent | null {
	const ref = stringField(body, 'ref')
	if (ref === undefined) {
		return null
	}
	const repository = prop(body, 'repository')
	const repoUrl = stringField(repository, 'clone_url') ?? stringField(repository, 'html_url')
	if (repoUrl === undefined) {
		return null
	}
	const commitSha = stringField(body, 'after') ?? null
	const installationRaw = prop(prop(body, 'installation'), 'id')
	const installationId = typeof installationRaw === 'number' && Number.isSafeInteger(installationRaw) && installationRaw > 0 ? installationRaw : null
	return { ref, repoUrl, commitSha, installationId }
}

// ── GitHubAppRepoSource (v1) ───────────────────────────────────────────────────

export interface GitHubAppConfig {
	/** The GitHub App id (numeric, as a string). */
	appId: string
	/** The GitHub App's PEM private key, used to sign the App JWT. NEVER logged. */
	privateKeyPem: string
	/** The webhook secret used to HMAC-verify inbound deliveries. NEVER logged. */
	webhookSecret: string
	/** Base API URL; override for GitHub Enterprise. Defaults to api.github.com. */
	apiBaseUrl?: string
	/** Injected HTTP implementation for tests and non-global runtimes. */
	fetch?: GitHubAppFetch
	/** Injected millisecond clock for deterministic tests. */
	now?: () => number
	/** Upper bound for a GitHub API request, including the response body. */
	timeoutMs?: number
}

/**
 * The v1 RepoSource backed by a GitHub App: mints an installation access token to build an
 * authenticated clone URL for a private repo, and HMAC-verifies inbound webhooks. The shared
 * GitHub App client owns credentials and GitHub API calls; webhook authentication remains here.
 */
export class GitHubAppRepoSource implements RepoSource {
	private client: Promise<GitHubAppClient> | undefined

	constructor(private readonly config: GitHubAppConfig) {}

	async clone(repoUrl: string, ref: string, installationId?: number | null, signal?: AbortSignal): Promise<CloneTarget> {
		signal?.throwIfAborted()
		const repository = parseCanonicalGitHubRepository(repoUrl)
		if (repository === null) {
			throw new Error('invalid canonical GitHub repository')
		}
		const httpsUrl = `https://github.com/${repository.owner}/${repository.repo}`
		// A public repo (no installation) clones from the bare https URL — no token needed.
		if (installationId === undefined || installationId === null) {
			return { cloneUrl: httpsUrl, ref }
		}
		const token = await this.repositoryToken(repository, installationId, signal)
		// x-access-token is GitHub's documented installation-token clone scheme.
		const url = new URL(httpsUrl)
		url.username = 'x-access-token'
		url.password = token
		signal?.throwIfAborted()
		return { cloneUrl: url.toString(), ref }
	}

	async resolveCommit(repoUrl: string, ref: string, installationId?: number | null, signal?: AbortSignal): Promise<{ commitSha: string }> {
		signal?.throwIfAborted()
		const repository = parseCanonicalGitHubRepository(repoUrl)
		if (repository === null) throw new Error('invalid canonical GitHub repository')
		const selected = parseGitHubSourceRef(ref)
		const transport = sourceTransport(this.config)
		const token = installationId === undefined || installationId === null ? undefined : await this.repositoryToken(repository, installationId, signal)
		const baseUrl = `${transport.apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git`
		const request: GitHubSourceRequest = (path, allowNotFound = false) =>
			requestGitHubSourceJson(`${baseUrl}/${path}`, transport, token, signal, allowNotFound)
		let commitSha: string
		if (selected.kind === 'commit') {
			commitSha = await verifyGitHubCommit(request, selected.sha)
		} else {
			let namespace = selected.kind === 'bare' ? 'heads' : selected.namespace
			const name = selected.name.split('/').map(encodeURIComponent).join('/')
			let body = await request(`ref/${namespace}/${name}`, selected.kind === 'bare')
			if (body === SOURCE_NOT_FOUND) {
				namespace = 'tags'
				body = await request(`ref/tags/${name}`)
			}
			if (stringField(body, 'ref') !== `refs/${namespace}/${selected.name}`) throw invalidSourceResponse()
			let object = parseGitHubSourceObject(prop(body, 'object'))
			if (namespace === 'heads' && object.type !== 'commit') throw invalidSourceResponse()
			const seen = new Set<string>()
			while (object.type === 'tag') {
				if (seen.size >= 8 || seen.has(object.sha)) throw invalidSourceResponse()
				seen.add(object.sha)
				const tag = await request(`tags/${object.sha}`)
				if (parseGitHubObjectSha(tag) !== object.sha) throw invalidSourceResponse()
				object = parseGitHubSourceObject(prop(tag, 'object'))
			}
			commitSha = await verifyGitHubCommit(request, object.sha)
		}
		signal?.throwIfAborted()
		return { commitSha }
	}

	/**
	 * Look up the installation id for `repoUrl` via `GET /repos/:owner/:repo/installation` (App-JWT auth).
	 * 404 = the App isn't installed on that repo → null. Any other non-2xx / non-GitHub host → null too,
	 * so onboarding never fails on a lookup miss. CF/integration only (real GitHub API). Never logs the JWT.
	 */
	async resolveInstallationId(repoUrl: string, signal?: AbortSignal): Promise<number | null> {
		const target = parseGitHubRepo(repoUrl)
		if (target === null) {
			return null
		}
		try {
			return await (await this.githubClient()).resolveInstallationId(target.owner, target.repo, signal)
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw error
			}
			return null
		}
	}

	async verifyWebhook(request: Request): Promise<PushEvent | null> {
		if (this.config.webhookSecret === '') {
			return null
		}
		return verifyPushWebhook(request, this.config.webhookSecret)
	}

	private githubClient(): Promise<GitHubAppClient> {
		this.client ??= GitHubAppClient.create(this.githubClientConfig())
		return this.client
	}

	private githubClientConfig(): GitHubAppClientConfig {
		return {
			appId: this.config.appId,
			privateKeyPem: this.config.privateKeyPem,
			...(this.config.apiBaseUrl === undefined ? {} : { apiBaseUrl: this.config.apiBaseUrl }),
			...(this.config.fetch === undefined ? {} : { fetch: this.config.fetch }),
			...(this.config.now === undefined ? {} : { now: this.config.now }),
			...(this.config.timeoutMs === undefined ? {} : { timeoutMs: this.config.timeoutMs }),
		}
	}

	private async repositoryToken(repository: { owner: string; repo: string }, installationId: number, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted()
		const deadline = createSourceDeadline(signal, sourceTimeoutMs(this.config))
		const fetchImplementation = this.config.fetch ?? fetch
		let response: Response | undefined
		let responseSignal: AbortSignal | undefined
		let settled = false
		const cancelBody = (): void => {
			const body = response?.body
			if (body !== undefined && body !== null && !body.locked) void body.cancel().catch(() => {})
		}
		try {
			const client = await awaitSourceOperation(
				GitHubAppClient.create({
					...this.githubClientConfig(),
					fetch: (input, init) =>
						fetchImplementation(input, init).then((received) => {
							response = received
							const requestSignal = init?.signal
							if (settled || requestSignal?.aborted) {
								cancelBody()
								requestSignal?.throwIfAborted()
								throw new Error('GitHub source authorization failed')
							}
							// Token minting makes one request; retain body ownership through the SDK handoff.
							responseSignal = requestSignal ?? undefined
							responseSignal?.addEventListener('abort', cancelBody, { once: true })
							return received
						}),
				}),
				deadline.signal,
			)
			deadline.signal.throwIfAborted()
			const token = await awaitSourceOperation(
				client.mintRepositoryToken({
					installationId,
					owner: repository.owner,
					repository: repository.repo,
					signal: deadline.signal,
				}),
				deadline.signal,
			)
			deadline.signal.throwIfAborted()
			return token.token
		} catch {
			// The shared client's onboarding AbortError must not replace deployment ownership reasons.
			signal?.throwIfAborted()
			throw new Error('GitHub source authorization failed')
		} finally {
			settled = true
			responseSignal?.removeEventListener('abort', cancelBody)
			cancelBody()
			deadline.dispose()
		}
	}
}

const SOURCE_NOT_FOUND = Symbol('source-not-found')
const SOURCE_MAX_RESPONSE_BYTES = 64 * 1024

type GitHubSourceRef = { kind: 'commit'; sha: string } | { kind: 'ref'; namespace: 'heads' | 'tags'; name: string } | { kind: 'bare'; name: string }
type GitHubSourceObject = { type: 'commit' | 'tag'; sha: string }
type GitHubSourceRequest = (path: string, allowNotFound?: boolean) => Promise<unknown>

interface GitHubSourceTransport {
	apiBaseUrl: string
	fetch: GitHubAppFetch
	timeoutMs: number
}

function parseGitHubSourceRef(ref: string): GitHubSourceRef {
	if (/^[0-9a-f]{64}$/i.test(ref)) throw new Error('GitHub source does not support 64-hex commit IDs')
	if (/^[0-9a-f]{40}$/i.test(ref)) return { kind: 'commit', sha: ref.toLowerCase() }
	let namespace: 'heads' | 'tags' | undefined
	let name = ref
	if (ref.startsWith('refs/heads/')) {
		namespace = 'heads'
		name = ref.slice('refs/heads/'.length)
	} else if (ref.startsWith('refs/tags/')) {
		namespace = 'tags'
		name = ref.slice('refs/tags/'.length)
	} else if (ref.startsWith('refs/')) {
		throw new Error('invalid GitHub source ref')
	}
	if (
		name.length === 0 || name.length > 1024 || name.startsWith('-') || name.endsWith('.') || name === '@' || name.includes('..') || name.includes('@{')
		|| /[\s\p{Cc}\p{Cs}~^:?*[\\]/u.test(name)
		|| name.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'))
	) {
		throw new Error('invalid GitHub source ref')
	}
	return namespace === undefined ? { kind: 'bare', name } : { kind: 'ref', namespace, name }
}

function parseGitHubObjectSha(body: unknown): string {
	const sha = stringField(body, 'sha')
	if (sha === undefined || !/^[0-9a-f]{40}$/i.test(sha)) throw invalidSourceResponse()
	return sha.toLowerCase()
}

function parseGitHubSourceObject(body: unknown): GitHubSourceObject {
	const type = stringField(body, 'type')
	if (type !== 'commit' && type !== 'tag') throw invalidSourceResponse()
	return { type, sha: parseGitHubObjectSha(body) }
}

async function verifyGitHubCommit(request: GitHubSourceRequest, expectedSha: string): Promise<string> {
	const sha = parseGitHubObjectSha(await request(`commits/${expectedSha}`))
	if (sha !== expectedSha) throw invalidSourceResponse()
	return sha
}

function invalidSourceResponse(): Error {
	return new Error('GitHub source response is invalid')
}

function sourceTimeoutMs(config: GitHubAppConfig): number {
	const timeoutMs = config.timeoutMs ?? 15_000
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new Error('GitHub source configuration is invalid')
	return timeoutMs
}

function sourceTransport(config: GitHubAppConfig): GitHubSourceTransport {
	const timeoutMs = sourceTimeoutMs(config)
	let apiBaseUrl: URL
	try {
		apiBaseUrl = new URL(config.apiBaseUrl ?? 'https://api.github.com')
	} catch {
		throw new Error('GitHub source configuration is invalid')
	}
	if (
		apiBaseUrl.protocol !== 'https:' || apiBaseUrl.username !== '' || apiBaseUrl.password !== '' || apiBaseUrl.search !== '' || apiBaseUrl.hash !== ''
	) {
		throw new Error('GitHub source configuration is invalid')
	}
	return { apiBaseUrl: apiBaseUrl.toString().replace(/\/$/, ''), fetch: config.fetch ?? fetch, timeoutMs }
}

function createSourceDeadline(callerSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController()
	const abortFromCaller = (): void => controller.abort(callerSignal?.reason)
	if (callerSignal?.aborted) abortFromCaller()
	else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
	const timer = setTimeout(() => controller.abort(new DOMException('GitHub source request timed out', 'TimeoutError')), timeoutMs)
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer)
			callerSignal?.removeEventListener('abort', abortFromCaller)
		},
	}
}

async function requestGitHubSourceJson(
	url: string,
	transport: GitHubSourceTransport,
	token: string | undefined,
	callerSignal: AbortSignal | undefined,
	allowNotFound: boolean,
): Promise<unknown> {
	const deadline = createSourceDeadline(callerSignal, transport.timeoutMs)
	const signal = deadline.signal
	let response: Response | undefined
	try {
		signal.throwIfAborted()
		const headers = new Headers({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'vozka' })
		if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
		const receivedResponse = await awaitSourceOperation(
			transport.fetch(url, { headers, redirect: 'error', signal }).then((received) => {
				if (signal.aborted) {
					void received.body?.cancel().catch(() => {})
					signal.throwIfAborted()
				}
				return received
			}),
			signal,
		)
		response = receivedResponse
		if (receivedResponse.redirected || (receivedResponse.status >= 300 && receivedResponse.status < 400)) throw invalidSourceResponse()
		if (allowNotFound && receivedResponse.status === 404) return SOURCE_NOT_FOUND
		if (!receivedResponse.ok) throw invalidSourceResponse()
		return await readSourceJson(receivedResponse, signal)
	} catch {
		callerSignal?.throwIfAborted()
		deadline.signal.throwIfAborted()
		throw new Error('GitHub source request failed')
	} finally {
		deadline.dispose()
		void response?.body?.cancel().catch(() => {})
	}
}

async function readSourceJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const declaredLength = response.headers.get('content-length')
	if (declaredLength !== null && /^[0-9]+$/.test(declaredLength) && Number(declaredLength) > SOURCE_MAX_RESPONSE_BYTES) throw invalidSourceResponse()
	const reader = response.body?.getReader()
	if (reader === undefined) throw invalidSourceResponse()
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		while (true) {
			signal.throwIfAborted()
			const result = await awaitSourceOperation(reader.read(), signal)
			if (result.done) break
			length += result.value.byteLength
			if (length > SOURCE_MAX_RESPONSE_BYTES) throw invalidSourceResponse()
			chunks.push(result.value)
		}
	} catch (error) {
		void reader.cancel().catch(() => {})
		throw error
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	signal.throwIfAborted()
	const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	signal.throwIfAborted()
	return body
}

function awaitSourceOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const aborted = (): void => {
			cleanup()
			try {
				signal.throwIfAborted()
			} catch (error) {
				reject(error)
			}
		}
		const cleanup = (): void => signal.removeEventListener('abort', aborted)
		signal.addEventListener('abort', aborted, { once: true })
		operation.then(
			(value) => {
				cleanup()
				try {
					signal.throwIfAborted()
					resolve(value)
				} catch (error) {
					reject(error)
				}
			},
			(error: unknown) => {
				cleanup()
				try {
					signal.throwIfAborted()
					reject(error)
				} catch (reason) {
					reject(reason)
				}
			},
		)
		if (signal.aborted) aborted()
	})
}

const verifyPushWebhook = async (request: Request, secret: string): Promise<PushEvent | null> => {
	const rawBody = await readWebhookBody(request)
	if (rawBody === null || !(await verifyWebhookSignature(rawBody, request.headers.get('X-Hub-Signature-256'), secret))) {
		return null
	}
	let body: unknown
	try {
		body = JSON.parse(rawBody)
	} catch {
		return null
	}
	return decodePushEvent(body)
}

const readWebhookBody = async (request: Request): Promise<string | null> => {
	const declaredLength = request.headers.get('content-length')
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength)
		if (Number.isFinite(parsedLength) && parsedLength > GITHUB_WEBHOOK_MAX_BYTES) {
			await request.body?.cancel().catch(() => {})
			return null
		}
	}
	if (request.body === null) return ''
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		while (true) {
			const result = await reader.read()
			if (result.done) break
			length += result.value.byteLength
			if (length > GITHUB_WEBHOOK_MAX_BYTES) {
				await reader.cancel().catch(() => {})
				return null
			}
			chunks.push(result.value)
		}
	} catch {
		return null
	}
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return null
	}
}

// ── FakeRepoSource (tests / local) ─────────────────────────────────────────────

export interface FakeRepoSourceConfig {
	/** Webhook secret to HMAC-verify against (so the verify path is exercised with a real signature). */
	webhookSecret?: string
	/** When set, `clone` embeds this token into the URL (stands in for a minted installation token). */
	fakeToken?: string
	/** What `resolveInstallationId` returns (stands in for the GitHub App lookup). Defaults to null. */
	fakeInstallationId?: number | null
}

/**
 * In-memory RepoSource for tests + local dev. `clone` returns the bare URL (or embeds `fakeToken`);
 * `verifyWebhook` runs the SAME real HMAC verification + push decode as the GitHub source, so webhook
 * tests cover the genuine signature check without GitHub.
 */
export class FakeRepoSource implements RepoSource {
	private readonly webhookSecret: string
	private readonly fakeToken: string | undefined
	private readonly fakeInstallationId: number | null

	constructor(config: FakeRepoSourceConfig = {}) {
		this.webhookSecret = config.webhookSecret ?? 'fake-webhook-secret'
		this.fakeToken = config.fakeToken
		this.fakeInstallationId = config.fakeInstallationId ?? null
	}

	resolveInstallationId(): Promise<number | null> {
		return Promise.resolve(this.fakeInstallationId)
	}

	clone(repoUrl: string, ref: string, installationId?: number | null): Promise<CloneTarget> {
		if (this.fakeToken !== undefined && installationId !== undefined && installationId !== null) {
			const url = new URL(repoUrl)
			url.username = 'x-access-token'
			url.password = this.fakeToken
			return Promise.resolve({ cloneUrl: url.toString(), ref })
		}
		return Promise.resolve({ cloneUrl: repoUrl, ref })
	}

	async verifyWebhook(request: Request): Promise<PushEvent | null> {
		const rawBody = await request.text()
		const ok = await verifyWebhookSignature(rawBody, request.headers.get('X-Hub-Signature-256'), this.webhookSecret)
		if (!ok) {
			return null
		}
		let body: unknown
		try {
			body = JSON.parse(rawBody)
		} catch {
			return null
		}
		return decodePushEvent(body)
	}
}

function parseCanonicalGitHubRepository(repoUrl: string): { owner: string; repo: string } | null {
	const match = /^github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/.exec(repoUrl)
	const owner = match?.[1]
	const repo = match?.[2]
	if (owner === undefined || repo === undefined || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
		return null
	}
	return { owner, repo }
}
