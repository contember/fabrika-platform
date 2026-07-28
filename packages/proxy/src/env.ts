/**
 * Runtime configuration, read from the environment. Kept separate from `main.ts` so the parsing is
 * testable without starting a server.
 *
 * `FABRIKA_IAM_KEY` is the only secret here. It is read once and never logged, never echoed and never
 * put in a URL.
 */

import { DEFAULT_IAM_TIMEOUT_MS } from './constants'

export interface ProxyEnv {
	/** Path to the deployed `proxy.manifest.json`. */
	manifestPath: string
	/** IAM's origin — token issuer and login base. */
	iamUrl: string
	/** Port the auth service listens on (loopback only; Caddy dials it). */
	port: number
	iamTimeoutMs: number
	/** False disables the token cache. Decisions are unchanged; IAM sees one call per request. */
	cacheEnabled: boolean
	/** Optional bearer the proxy authenticates itself to IAM with. */
	iamKey: string | undefined
}

/** Thrown when required configuration is missing. Refusing to boot beats booting misconfigured. */
export class ProxyEnvError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ProxyEnvError'
	}
}

export function readProxyEnv(source: Record<string, string | undefined>): ProxyEnv {
	const iamUrl = source['FABRIKA_IAM_URL']
	if (iamUrl === undefined || iamUrl === '') {
		throw new ProxyEnvError('FABRIKA_IAM_URL is required')
	}
	const key = source['FABRIKA_IAM_KEY']
	return {
		manifestPath: source['FABRIKA_PROXY_MANIFEST'] ?? './proxy.manifest.json',
		iamUrl,
		port: positiveInt(source['FABRIKA_PROXY_PORT'], 9000),
		iamTimeoutMs: positiveInt(source['FABRIKA_IAM_TIMEOUT_MS'], DEFAULT_IAM_TIMEOUT_MS),
		// Anything other than an explicit 'off' keeps the cache — a typo must not silently make the
		// proxy hammer IAM, and it can never make it permissive.
		cacheEnabled: source['FABRIKA_PROXY_CACHE'] !== 'off',
		iamKey: key === undefined || key === '' ? undefined : key,
	}
}

function positiveInt(raw: string | undefined, fallback: number): number {
	if (raw === undefined) {
		return fallback
	}
	const value = Number.parseInt(raw, 10)
	return Number.isFinite(value) && value > 0 ? value : fallback
}
