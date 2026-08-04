/**
 * Runtime configuration, read from the environment. Kept separate from `main.ts` so the parsing is
 * testable without starting a server.
 *
 * `FABRIKA_IAM_KEY` is the only secret here. It is REQUIRED — refusing to boot beats booting
 * misconfigured — and it is read once and never logged, never echoed and never put in a URL.
 */

import { DEFAULT_IAM_TIMEOUT_MS } from './constants'

export interface ProxyEnv {
	/** Path to the deployed `proxy.manifest.json`. */
	manifestPath: string
	/**
	 * IAM's ORIGIN — canonicalized here and nowhere else. The same string is compared byte-for-byte
	 * against a token's `iss`, dialed as the HTTP base, and used to build the login bounce; a trailing
	 * slash that only two of those tolerate is a sign-in that fails for no visible reason.
	 */
	iamUrl: string
	/** Port the auth service listens on (loopback only; Caddy dials it). */
	port: number
	iamTimeoutMs: number
	/** False disables the token cache. Decisions are unchanged; IAM sees one call per request. */
	cacheEnabled: boolean
	/** The bearer the proxy authenticates itself to IAM with. Required — see `readProxyEnv`. */
	iamKey: string
}

/** Thrown when required configuration is missing. Refusing to boot beats booting misconfigured. */
export class ProxyEnvError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ProxyEnvError'
	}
}

export function readProxyEnv(source: Record<string, string | undefined>): ProxyEnv {
	const rawIamUrl = source['FABRIKA_IAM_URL']
	if (rawIamUrl === undefined || rawIamUrl === '') {
		throw new ProxyEnvError('FABRIKA_IAM_URL is required')
	}
	const key = source['FABRIKA_IAM_KEY']
	if (key === undefined || key === '') {
		// IAM's mint surface 404s without the matching key, so a proxy that boots without one answers
		// 503 to every request it cannot decide locally. Fail here, where the cause is still legible.
		throw new ProxyEnvError('FABRIKA_IAM_KEY is required')
	}
	return {
		manifestPath: source['FABRIKA_PROXY_MANIFEST'] ?? './proxy.manifest.json',
		iamUrl: originOf(rawIamUrl),
		port: positiveInt(source['FABRIKA_PROXY_PORT'], 9000),
		iamTimeoutMs: positiveInt(source['FABRIKA_IAM_TIMEOUT_MS'], DEFAULT_IAM_TIMEOUT_MS),
		// Anything other than an explicit 'off' keeps the cache — a typo must not silently make the
		// proxy hammer IAM, and it can never make it permissive.
		cacheEnabled: source['FABRIKA_PROXY_CACHE'] !== 'off',
		iamKey: key,
	}
}

/** Reduce a configured IAM URL to its origin, so every downstream use compares the same bytes. */
function originOf(raw: string): string {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new ProxyEnvError('FABRIKA_IAM_URL must be an absolute http(s) URL')
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new ProxyEnvError('FABRIKA_IAM_URL must be an absolute http(s) URL')
	}
	return url.origin
}

function positiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined) {
		return fallback
	}
	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}
