import { type OAuthClientMetadataDocument, parseOAuthClientMetadata } from '@fabrika/iam-contract'
import type { JSONWebKeySet, JWK } from 'jose'
import { prop } from './json'
import type { ManagedOAuthClient } from './oauth-config'

const CACHE_TTL_MS = 300_000
const FAILURE_TTL_MS = 30_000
const CACHE_MAX_ENTRIES = 64
const FETCH_TIMEOUT_MS = 5_000
const MAX_DOCUMENT_BYTES = 16_384
const MAX_JWKS_BYTES = 65_536
const MAX_JWKS_KEYS = 32
/** An assertion naming an unknown `kid` refetches the key set, but at most this often per key set. */
const JWKS_REFETCH_INTERVAL_MS = 30_000

interface CacheEntry<T> {
	fetchedAt: number
	expiresAt: number
	value: Promise<T | null>
}

/**
 * One fetch per key at a time: concurrent callers share it, and a failure is remembered briefly so a
 * burst of requests cannot turn into a burst of fetches.
 */
class FetchCache<T> {
	private readonly entries = new Map<string, CacheEntry<T>>()

	constructor(private readonly ttlMs: number) {}

	get(key: string, load: () => Promise<T | null>, options: { refetchAfterMs?: number } = {}): Promise<T | null> {
		const now = Date.now()
		const cached = this.entries.get(key)
		const refetch = options.refetchAfterMs !== undefined && cached !== undefined && now - cached.fetchedAt >= options.refetchAfterMs
		if (cached !== undefined && cached.expiresAt > now && !refetch) return cached.value
		if (this.entries.size >= CACHE_MAX_ENTRIES) this.entries.clear()
		const value = load()
		// An in-flight entry lives until the fetch settles; the outcome then sets how long it is kept.
		const entry: CacheEntry<T> = { fetchedAt: now, expiresAt: Number.POSITIVE_INFINITY, value }
		this.entries.set(key, entry)
		void value.then((result) => {
			entry.expiresAt = Date.now() + (result === null ? FAILURE_TTL_MS : this.ttlMs)
		})
		return value
	}
}

const metadataCache = new FetchCache<OAuthClientMetadataDocument>(CACHE_TTL_MS)
const jwksCache = new FetchCache<JSONWebKeySet>(CACHE_TTL_MS)

/**
 * The Client ID Metadata Document of an operator-registered client. Callers resolve the registration
 * first, so an unregistered client id never causes a fetch. The key is the whole registration, so a
 * config change is never answered from the old document.
 */
export function clientMetadata(registration: ManagedOAuthClient): Promise<OAuthClientMetadataDocument | null> {
	return metadataCache.get(JSON.stringify(registration), async () => {
		const document = await fetchJson(registration.metadataUrl, MAX_DOCUMENT_BYTES)
		return document === null ? null : parseOAuthClientMetadata(document, registration)
	})
}

/**
 * The public keys at a client's `jwks_uri`, which its parsed metadata document already confined to the
 * client id's origin. `refetch` asks for a fresh copy (an assertion named an unknown `kid`); it is
 * honoured once per `JWKS_REFETCH_INTERVAL_MS`, so assertions cannot drive fetches.
 */
export function clientJwks(jwksUri: string, options: { refetch: boolean }): Promise<JSONWebKeySet | null> {
	return jwksCache.get(jwksUri, async () => parseJwks(await fetchJson(jwksUri, MAX_JWKS_BYTES)), {
		refetchAfterMs: options.refetch ? JWKS_REFETCH_INTERVAL_MS : undefined,
	})
}

/** HTTPS GET of a JSON document: no redirects, a timeout, and a size bound enforced while reading. */
async function fetchJson(url: string, maxBytes: number): Promise<unknown> {
	try {
		// `manual` rather than `error`: Workers do not implement `error`, and a 3xx is refused below either way.
		const response = await fetch(url, {
			redirect: 'manual',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { accept: 'application/json' },
		})
		if (response.status !== 200 || response.body === null || Number(response.headers.get('content-length') ?? '0') > maxBytes) {
			await response.body?.cancel()
			return null
		}
		const reader = response.body.getReader()
		const decoder = new TextDecoder('utf-8', { fatal: true })
		let bytes = 0
		let body = ''
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			bytes += chunk.value.byteLength
			if (bytes > maxBytes) {
				await reader.cancel()
				return null
			}
			body += decoder.decode(chunk.value, { stream: true })
		}
		body += decoder.decode()
		const document: unknown = JSON.parse(body)
		return document
	} catch {
		return null
	}
}

/** RSA public keys only, the one key type the supported algorithms use; private members are never copied. */
function parseJwks(value: unknown): JSONWebKeySet | null {
	const rawKeys = prop(value, 'keys')
	if (!Array.isArray(rawKeys) || rawKeys.length > MAX_JWKS_KEYS) return null
	const keys: JWK[] = []
	for (const raw of rawKeys) {
		const kty = text(raw, 'kty')
		const n = text(raw, 'n')
		const e = text(raw, 'e')
		if (kty !== 'RSA' || n === undefined || e === undefined) continue
		const key: JWK = { kty, n, e }
		const kid = text(raw, 'kid')
		const alg = text(raw, 'alg')
		const use = text(raw, 'use')
		if (kid !== undefined) key.kid = kid
		if (alg !== undefined) key.alg = alg
		if (use !== undefined) key.use = use
		keys.push(key)
	}
	return keys.length === 0 ? null : { keys }
}

function text(value: unknown, name: string): string | undefined {
	const member = prop(value, name)
	return typeof member === 'string' && member.length > 0 ? member : undefined
}
