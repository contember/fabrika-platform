// GitHub push webhooks: HMAC verification against one connection's secret, payload decoding, and the
// repository URL normalization both the webhook and the registry match on. Public repositories have no
// webhook; their trigger is pulled by `src/repo-poll.ts`.

import { z } from 'zod'

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

export interface PushWebhookVerifier {
	verifyWebhook(request: Request): Promise<PushEvent | null>
}

/** Supplies the current webhook HMAC secret without exposing it through connection state. */
export interface WebhookSecretProvider {
	getSecret(signal?: AbortSignal): Promise<string | null>
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

/** Verify a push against one connection's webhook secret, read per delivery. */
export class ConnectionWebhookVerifier implements PushWebhookVerifier {
	constructor(private readonly webhookSecrets: WebhookSecretProvider) {}

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
	const parsed = pushPayloadSchema.safeParse(body)
	if (!parsed.success) return null
	const { ref, repository, after, installation } = parsed.data
	const repoUrl = repository.clone_url ?? repository.html_url
	if (repoUrl === undefined) {
		return null
	}
	return { ref, repoUrl, commitSha: after ?? null, installationId: installation?.id ?? null }
}

const pushPayloadSchema = z.object({
	ref: z.string(),
	repository: z.object({ clone_url: z.string().optional().catch(undefined), html_url: z.string().optional().catch(undefined) }),
	after: z.string().optional().catch(undefined),
	installation: z.object({ id: z.number().int().safe().positive().optional().catch(undefined) }).optional().catch(undefined),
})

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
