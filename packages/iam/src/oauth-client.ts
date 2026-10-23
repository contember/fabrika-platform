import { type OAuthClientMetadataDocument, parseOAuthClientMetadata } from '@fabrika/iam-contract'
import type { ManagedOAuthClient } from './oauth-config'

const CACHE_TTL_MS = 300_000
const FAILURE_TTL_MS = 30_000
const CACHE_MAX_ENTRIES = 64
const FETCH_TIMEOUT_MS = 5_000
const MAX_DOCUMENT_BYTES = 16_384

const cache = new Map<string, { expiresAt: number; metadata: Promise<OAuthClientMetadataDocument | null> }>()

/**
 * The Client ID Metadata Document of an operator-registered client. Callers resolve the registration
 * first, so an unregistered client id never causes a fetch. Concurrent callers share one fetch, and a
 * failure is remembered briefly so a burst of authorize requests cannot turn into a burst of fetches.
 * The key is the whole registration, so a config change is never answered from the old document.
 */
export function clientMetadata(registration: ManagedOAuthClient): Promise<OAuthClientMetadataDocument | null> {
	const key = JSON.stringify(registration)
	const now = Date.now()
	const cached = cache.get(key)
	// On Workers a fetch belongs to the request that started it and never settles once that request is
	// cancelled, so a caller sharing it waits no longer than the entry lives.
	if (cached !== undefined && cached.expiresAt > now) return withinDeadline(cached.metadata, cached.expiresAt - now)
	if (cache.size >= CACHE_MAX_ENTRIES) cache.clear()
	const metadata = fetchMetadata(registration)
	// An in-flight entry lives as long as its fetch may run; the outcome then sets how long it is kept.
	const entry = { expiresAt: now + FETCH_TIMEOUT_MS, metadata }
	cache.set(key, entry)
	void metadata.then((document) => {
		entry.expiresAt = Date.now() + (document === null ? FAILURE_TTL_MS : CACHE_TTL_MS)
	})
	return metadata
}

/** The shared outcome, or `null` — a failed fetch — once `ms` have passed. */
function withinDeadline(metadata: Promise<OAuthClientMetadataDocument | null>, ms: number): Promise<OAuthClientMetadataDocument | null> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const deadline = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms)
	})
	return Promise.race([metadata, deadline]).finally(() => clearTimeout(timer))
}

async function fetchMetadata(registration: ManagedOAuthClient): Promise<OAuthClientMetadataDocument | null> {
	try {
		// `manual` rather than `error`: Workers do not implement `error`, and a 3xx is refused below either way.
		const response = await fetch(registration.metadataUrl, {
			redirect: 'manual',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { accept: 'application/json' },
		})
		if (response.status !== 200 || response.body === null || Number(response.headers.get('content-length') ?? '0') > MAX_DOCUMENT_BYTES) {
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
			if (bytes > MAX_DOCUMENT_BYTES) {
				await reader.cancel()
				return null
			}
			body += decoder.decode(chunk.value, { stream: true })
		}
		body += decoder.decode()
		const document: unknown = JSON.parse(body)
		return parseOAuthClientMetadata(document, registration)
	} catch {
		return null
	}
}
