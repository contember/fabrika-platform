/**
 * The proxy's view of the IAM service: the three cold-path calls it needs, and nothing else.
 *
 * `IamGateway` is a STRUCTURAL SUBSET of `IamRpc`, so on Cloudflare the thin Worker passes its
 * `env.IAM` service binding straight in with no adapter. On Zerops there is no binding, so
 * `HttpIamGateway` speaks HTTP to the global IAM service — the public hop ADR-0022 calls cold-path
 * only: everything after the first exchange is a local JWKS verification against the cached token.
 *
 * FAIL-CLOSED CONTRACT: an unreachable, slow or incoherent IAM raises `IamUnavailableError`. A
 * *decided* negative (`{ ok: false, reason }`) is returned normally. The caller must map the former
 * to a deny too — the distinction only chooses the status, never the outcome.
 */

import type {
	ExchangeAuthCodeInput,
	ExchangeAuthCodeResult,
	Jwks,
	MintFromKeyInput,
	MintFromKeyResult,
	MintTokenInput,
	MintTokenResult,
} from '@fabrika/auth-core'
import { parseJwks } from '@fabrika/jwks'
import { z } from 'zod'
import { DEFAULT_IAM_TIMEOUT_MS } from './constants'

const denialSchema = z.object({ ok: z.literal(false), reason: z.string() })
const mintResultSchema = z.discriminatedUnion('ok', [
	z.object({ ok: z.literal(true), token: z.string().min(1), expiresAt: z.number().finite() }),
	denialSchema,
])
const exchangeResultSchema = z.discriminatedUnion('ok', [
	z.object({ ok: z.literal(true), session: z.string().min(1), returnUrl: z.string().min(1), expiresAt: z.number().finite() }),
	denialSchema,
])

/**
 * What the proxy needs of IAM. IAM's entrypoints satisfy it structurally — the CF binding drops
 * straight in with no adapter. Three of the four calls are `IamRpc`; `exchangeAuthCode` is
 * deliberately NOT (`IamHandoffRpc`, ADR-0022), because only the proxy may turn a handoff code into
 * a session and `IamRpc` is held by every SDK consumer.
 */
export interface IamGateway {
	mintToken(input: MintTokenInput): Promise<MintTokenResult>
	mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult>
	exchangeAuthCode(input: ExchangeAuthCodeInput): Promise<ExchangeAuthCodeResult>
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
 * HTTP transport for `IamGateway` — the Zerops path, where there is no service binding.
 *
 * This file and `packages/iam/src/rpc-http.ts` are two halves of one contract; neither may move
 * without the other in the SAME commit. A mismatch fails closed (any non-200 becomes
 * `IamUnavailableError` → a 503 deny) but is very hard to read from the outside.
 *
 *   POST {origin}/auth/mint/session   {app, session, requestId} -> MintTokenResult
 *   POST {origin}/auth/mint/key       {app, key, requestId}     -> MintFromKeyResult
 *   POST {origin}/auth/mint/exchange  {app, code, requestId}    -> ExchangeAuthCodeResult   (ADR-0022)
 *   GET  {origin}/.well-known/jwks.json                         -> Jwks                     (public)
 *
 * The three POST endpoints are the `/auth/mint/*` PROXY surface, gated by IAM's `proxyKey` — the
 * least-privilege split ADR-0022 requires, kept apart from the management `/rpc/*` surface. They
 * answer **200 on any decided outcome, including a denial**: `{ ok: false, reason }` is "IAM answered:
 * no", a non-200 is "IAM could not be consulted". Both deny; only the second is an incident.
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
		const result = mintResultSchema.safeParse(await this.post('/auth/mint/session', input, 'mintToken'))
		if (!result.success) {
			throw new IamUnavailableError('mintToken')
		}
		const parsed = result.data
		if (parsed.ok) {
			return parsed
		}
		return {
			ok: false,
			reason: reasonOf(parsed.reason, ['no_session', 'invalid_session', 'unknown_principal', 'disabled', 'token_too_large'], 'invalid_session'),
		}
	}

	async mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult> {
		const result = mintResultSchema.safeParse(await this.post('/auth/mint/key', input, 'mintFromKey'))
		if (!result.success) {
			throw new IamUnavailableError('mintFromKey')
		}
		const parsed = result.data
		if (parsed.ok) {
			return parsed
		}
		return { ok: false, reason: reasonOf(parsed.reason, ['invalid_key', 'unknown_principal', 'disabled', 'token_too_large'], 'invalid_key') }
	}

	async exchangeAuthCode(input: ExchangeAuthCodeInput): Promise<ExchangeAuthCodeResult> {
		const result = exchangeResultSchema.safeParse(await this.post('/auth/mint/exchange', input, 'exchangeAuthCode'))
		if (!result.success) {
			throw new IamUnavailableError('exchangeAuthCode')
		}
		if (result.data.ok) return result.data
		return {
			ok: false,
			reason: reasonOf(
				result.data.reason,
				['invalid_code', 'expired_code', 'wrong_app', 'invalid_verifier', 'unknown_principal', 'disabled'],
				'invalid_code',
			),
		}
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
