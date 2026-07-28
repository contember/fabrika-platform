/**
 * The proxy's view of the IAM service: the three cold-path calls it needs, and nothing else.
 *
 * `IamGateway` is a STRUCTURAL SUBSET of `IamRpc`, so on Cloudflare the thin Worker passes its
 * `env.IAM` service binding straight in with no adapter. On Zerops there is no binding, so
 * `HttpIamGateway` speaks HTTP to the global IAM service — the public hop ADR-0007 calls cold-path
 * only: everything after the first exchange is a local JWKS verification against the cached token.
 *
 * FAIL-CLOSED CONTRACT: an unreachable, slow or incoherent IAM raises `IamUnavailableError`. A
 * *decided* negative (`{ ok: false, reason }`) is returned normally. The caller must map the former
 * to a deny too — the distinction only chooses the status, never the outcome.
 */

import type { Jwks, MintFromKeyInput, MintFromKeyResult, MintTokenInput, MintTokenResult, PublicJwk } from '@fabrika/auth-core'
import { DEFAULT_IAM_TIMEOUT_MS } from './constants'
import { numberField, prop, stringField } from './json'

/** What the proxy needs of IAM. `IamRpc` satisfies it structurally — the CF binding drops straight in. */
export interface IamGateway {
	mintToken(input: MintTokenInput): Promise<MintTokenResult>
	mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult>
	getJwks(): Promise<Jwks>
}

/**
 * IAM could not be consulted — network failure, timeout, non-200, or a body we cannot read. Distinct
 * from a decided denial: we do not know the answer, so the request is denied with 503 rather than
 * being told it is unauthorized.
 *
 * Carries NO cause and no response body: an error object from `fetch` can carry a URL, and a body
 * can carry a token.
 */
export class IamUnavailableError extends Error {
	constructor(readonly operation: string) {
		super(`iam unavailable: ${operation}`)
		this.name = 'IamUnavailableError'
	}
}

export interface HttpIamGatewayOptions {
	/** The IAM service origin, e.g. `https://iam.example.com` (trailing slash tolerated). */
	origin: string
	/** Per-call timeout. A hung IAM must deny, not hang every request behind the proxy. */
	timeoutMs?: number
	/** Optional `Authorization: Bearer` the proxy authenticates ITSELF to IAM with. */
	key?: string
	/** Injectable for tests; defaults to the global `fetch`. */
	fetch?: FetchLike
}

/**
 * Just the call shape the gateway uses. Narrower than `typeof fetch` on purpose: the global carries
 * runtime-specific extras (Bun's `preconnect`) that a test double has no business implementing.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/**
 * HTTP transport for `IamGateway`.
 *
 * The mint endpoints do NOT exist in `@fabrika/iam` yet — it exposes `mintToken`/`mintFromKey` over
 * the Worker RPC binding only. Standing them up is a required follow-up; this client is written
 * against the contract they must implement:
 *
 *   POST {origin}/auth/mint/session  {app, session, requestId} -> MintTokenResult    (always 200)
 *   POST {origin}/auth/mint/key      {app, key, requestId}     -> MintFromKeyResult  (always 200)
 *   GET  {origin}/.well-known/jwks.json                        -> Jwks               (already exists)
 *
 * Credentials always ride in the POST body, never in a URL — a URL ends up in access logs and error
 * strings; a body does not.
 */
export class HttpIamGateway implements IamGateway {
	private readonly origin: string
	private readonly timeoutMs: number
	private readonly key: string | undefined
	private readonly fetchImpl: FetchLike

	constructor(options: HttpIamGatewayOptions) {
		this.origin = options.origin.replace(/\/+$/, '')
		this.timeoutMs = options.timeoutMs ?? DEFAULT_IAM_TIMEOUT_MS
		this.key = options.key
		this.fetchImpl = options.fetch ?? globalThis.fetch
	}

	async mintToken(input: MintTokenInput): Promise<MintTokenResult> {
		const parsed = parseMintResult(await this.post('/auth/mint/session', input, 'mintToken'))
		if (parsed === null) {
			throw new IamUnavailableError('mintToken')
		}
		if (parsed.ok) {
			return parsed
		}
		return { ok: false, reason: reasonOf(parsed.reason, ['no_session', 'invalid_session', 'unknown_principal', 'disabled'], 'invalid_session') }
	}

	async mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult> {
		const parsed = parseMintResult(await this.post('/auth/mint/key', input, 'mintFromKey'))
		if (parsed === null) {
			throw new IamUnavailableError('mintFromKey')
		}
		if (parsed.ok) {
			return parsed
		}
		return { ok: false, reason: reasonOf(parsed.reason, ['invalid_key', 'unknown_principal', 'disabled'], 'invalid_key') }
	}

	async getJwks(): Promise<Jwks> {
		const response = await this.send('/.well-known/jwks.json', undefined, 'getJwks')
		const body: unknown = await response.json().catch(() => null)
		const jwks = parseJwks(body)
		if (jwks === null) {
			throw new IamUnavailableError('getJwks')
		}
		return jwks
	}

	private async post(path: string, payload: unknown, operation: string): Promise<unknown> {
		const response = await this.send(path, JSON.stringify(payload), operation)
		return response.json().catch(() => null)
	}

	private async send(path: string, body: string | undefined, operation: string): Promise<Response> {
		const headers = new Headers({ accept: 'application/json' })
		if (body !== undefined) {
			headers.set('content-type', 'application/json')
		}
		if (this.key !== undefined) {
			headers.set('authorization', `Bearer ${this.key}`)
		}
		let response: Response
		try {
			response = await this.fetchImpl(`${this.origin}${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers,
				body,
				signal: AbortSignal.timeout(this.timeoutMs),
			})
		} catch {
			// Deliberately swallow the cause: a fetch error stringifies the request URL and, on some
			// runtimes, request detail. We only ever surface the operation name.
			throw new IamUnavailableError(operation)
		}
		if (!response.ok) {
			throw new IamUnavailableError(operation)
		}
		return response
	}
}

/** The shared `{ok:true,token,expiresAt} | {ok:false,reason}` wire shape, read structurally. */
type ParsedMint = { ok: true; token: string; expiresAt: number } | { ok: false; reason: string }

function parseMintResult(body: unknown): ParsedMint | null {
	const ok = prop(body, 'ok')
	if (ok === true) {
		const token = stringField(body, 'token')
		const expiresAt = numberField(body, 'expiresAt')
		if (token === undefined || token === '' || expiresAt === undefined) {
			return null
		}
		return { ok: true, token, expiresAt }
	}
	if (ok === false) {
		const reason = stringField(body, 'reason')
		return reason === undefined ? null : { ok: false, reason }
	}
	return null
}

/**
 * Narrow a wire `reason` string to the declared union without a cast. An unrecognised reason degrades
 * to the given fallback, which is always a DENY reason — an IAM that starts speaking a dialect we do
 * not know must not be able to talk us into an allow.
 */
function reasonOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
	for (const candidate of allowed) {
		if (candidate === value) {
			return candidate
		}
	}
	return fallback
}

function parseJwks(body: unknown): Jwks | null {
	const rawKeys = prop(body, 'keys')
	if (!Array.isArray(rawKeys)) {
		return null
	}
	const keys: PublicJwk[] = []
	for (const raw of rawKeys) {
		const kty = stringField(raw, 'kty')
		if (kty === undefined) {
			return null
		}
		const key: PublicJwk = { kty }
		for (const field of ['crv', 'x', 'y', 'kid', 'alg', 'use'] as const) {
			const value = stringField(raw, field)
			if (value !== undefined) {
				key[field] = value
			}
		}
		keys.push(key)
	}
	return { keys }
}
