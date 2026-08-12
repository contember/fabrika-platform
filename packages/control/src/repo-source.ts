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

import { GitHubAppClient, type GitHubAppFetch, pemToPkcs8 } from '@fabrika/github-app'
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
	constructor(
		private readonly webhookSecret: string | undefined,
		private readonly installations: RepoInstallationLookup,
	) {}

	resolveInstallationId(repoUrl: string, signal?: AbortSignal): Promise<number | null> {
		return this.installations.resolveInstallationId(repoUrl, signal)
	}

	async verifyWebhook(request: Request): Promise<PushEvent | null> {
		const secret = this.webhookSecret
		if (secret === undefined || secret === '') {
			return null
		}
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
	if (hex.length !== 64) {
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
		const repository = parseCanonicalGitHubRepository(repoUrl)
		if (repository === null) {
			throw new Error('invalid canonical GitHub repository')
		}
		const httpsUrl = `https://github.com/${repository.owner}/${repository.repo}`
		// A public repo (no installation) clones from the bare https URL — no token needed.
		if (installationId === undefined || installationId === null) {
			return { cloneUrl: httpsUrl, ref }
		}
		const token = await (await this.githubClient()).mintRepositoryToken({
			installationId,
			owner: repository.owner,
			repository: repository.repo,
			...(signal === undefined ? {} : { signal }),
		})
		// x-access-token is GitHub's documented installation-token clone scheme.
		const url = new URL(httpsUrl)
		url.username = 'x-access-token'
		url.password = token.token
		return { cloneUrl: url.toString(), ref }
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
		this.client ??= GitHubAppClient.create({
			appId: this.config.appId,
			privateKeyPem: this.config.privateKeyPem,
			...(this.config.apiBaseUrl === undefined ? {} : { apiBaseUrl: this.config.apiBaseUrl }),
			...(this.config.fetch === undefined ? {} : { fetch: this.config.fetch }),
			...(this.config.now === undefined ? {} : { now: this.config.now }),
			...(this.config.timeoutMs === undefined ? {} : { timeoutMs: this.config.timeoutMs }),
		})
		return this.client
	}
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
