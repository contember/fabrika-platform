/**
 * `IamRpc` over HTTP — the transport an app needs when it has no Cloudflare service binding.
 *
 * WHAT THIS IS NOT: it is not a second IAM. `IamRpc` (@fabrika/auth-core) is unchanged and this class
 * holds no policy — it POSTs the method's input as JSON, reads the result back, and hands it to the
 * same callers (`PropustkaAuth`, `IamClient`) the binding serves. Everything downstream of the
 * contract — gate matching, local token verification, `can()`/`scopedTo()`, delegation checks inside
 * the IAM service — is byte-for-byte the same code on both transports. The ONLY difference is how the
 * call travels.
 *
 * THE WIRE IS `@fabrika/iam`'s `src/rpc-http.ts`, and that file is the contract:
 *
 *   POST {origin}/rpc/<method>   Authorization: Bearer <key>   body = the method's input
 *     → 200 with the method's result (INCLUDING a decided `{ ok: false, reason }`)
 *     → 204 for `audit` (it returns void over the binding, so there is nothing to encode)
 *     → 401 bad/absent key · 404 no such method OR the surface is disabled (an unset key 404s) ·
 *       400 undecodable body · 405 not a POST
 *
 * A DECIDED NEGATIVE IS A 200, and that distinction is the whole point: `{ ok: false, reason }` means
 * "IAM answered: no", while a non-200 means "IAM could not be consulted". Only the second is an
 * incident, and only the second throws here.
 *
 * ── Why a transport failure THROWS ────────────────────────────────────────────────────────────────
 *
 * Over a service binding an unreachable IAM is not a case a caller has to model: the binding either
 * resolves or the whole invocation fails. Over HTTP it is a real state, and mapping it onto the
 * contract's `reason` union would be a lie — `invalid_session` says "we checked, and no", which is not
 * what happened. So it raises `IamTransportError`, callers see a 5xx, and nothing is ever admitted on
 * the strength of an answer that never arrived. This is the same split `@fabrika/proxy`'s
 * `HttpIamGateway` makes with `IamUnavailableError`.
 *
 * ── One instance per process, deliberately ────────────────────────────────────────────────────────
 *
 * `PropustkaAuth` caches the fetched JWKS and the tokens minted from `px_` keys in `WeakMap`s keyed by
 * THE BINDING OBJECT. A fresh `HttpIamRpc` per request would therefore miss both caches every time and
 * re-fetch the JWKS on every request. Build one for the process's lifetime and put it in the env, the
 * way a binding lives for the isolate's lifetime.
 *
 * The key is a TRANSPORT credential, never a caller identity: it says "this request came from inside
 * the deployment", exactly as a binding's unreachability does. Per-caller authorization still happens
 * inside IAM, from the credential carried in the method's own input. It is never logged.
 */

import type {
	AuditInput,
	IamRpc,
	IssueJwtInput,
	IssueJwtResult,
	IssueKeyInput,
	IssueKeyResult,
	Jwks,
	ListPrincipalsInput,
	ListPrincipalsResult,
	MintFromKeyInput,
	MintFromKeyResult,
	MintTokenInput,
	MintTokenResult,
	PrincipalListItem,
	PrincipalType,
	PublicJwk,
	RevokeKeyInput,
	RevokeKeyResult,
} from '@fabrika/auth-core'
import { booleanField, numberField, prop, stringField } from './json'

/** Default per-call timeout. A hung IAM must fail the request, not hold a connection open forever. */
const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Just the call shape this client uses. Narrower than `typeof fetch` on purpose: the global carries
 * runtime-specific extras (Bun's `preconnect`) that a test double has no business implementing.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface HttpIamRpcOptions {
	/** The IAM service origin, e.g. `http://iam:3000` on a private network (trailing slash tolerated). */
	origin: string
	/** The shared secret gating `/rpc/*` (`FABRIKA_IAM_RPC_KEY` on the IAM side). NEVER logged. */
	key: string
	/** Per-call timeout in milliseconds. */
	timeoutMs?: number
	/** Injectable for tests; defaults to the global `fetch`. */
	fetch?: FetchLike
}

/**
 * IAM could not be consulted — network failure, timeout, a non-2xx status, or a body that does not
 * match the contract. Distinct from a decided denial, which is a normal result.
 *
 * Carries NO cause and no response body: a `fetch` error stringifies the request URL, and a body can
 * quote a credential that was on the way in.
 */
export class IamTransportError extends Error {
	constructor(readonly method: string) {
		super(`iam unavailable: ${method}`)
		this.name = 'IamTransportError'
	}
}

export class HttpIamRpc implements IamRpc {
	private readonly origin: string
	private readonly key: string
	private readonly timeoutMs: number
	private readonly fetchImpl: FetchLike

	constructor(options: HttpIamRpcOptions) {
		this.origin = options.origin.replace(/\/+$/, '')
		this.key = options.key
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
		this.fetchImpl = options.fetch ?? globalThis.fetch
	}

	async mintToken(input: MintTokenInput): Promise<MintTokenResult> {
		const body = await this.call('mintToken', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return { ok: false, reason: oneOf(failure, ['no_session', 'invalid_session', 'unknown_principal', 'disabled'], 'invalid_session') }
		}
		return readMintSuccess(body, 'mintToken')
	}

	async mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult> {
		const body = await this.call('mintFromKey', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return { ok: false, reason: oneOf(failure, ['invalid_key', 'unknown_principal', 'disabled'], 'invalid_key') }
		}
		return readMintSuccess(body, 'mintFromKey')
	}

	async issueKey(input: IssueKeyInput): Promise<IssueKeyResult> {
		const body = await this.call('issueKey', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return { ok: false, reason: oneOf(failure, ISSUE_REASONS, 'not_allowed') }
		}
		const token = stringField(body, 'token')
		const id = stringField(body, 'id')
		if (token === undefined || id === undefined) {
			throw new IamTransportError('issueKey')
		}
		const principalId = stringField(body, 'principalId')
		return { ok: true, token, id, ...(principalId === undefined ? {} : { principalId }) }
	}

	async issueJwt(input: IssueJwtInput): Promise<IssueJwtResult> {
		const body = await this.call('issueJwt', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return { ok: false, reason: oneOf(failure, ISSUE_REASONS, 'not_allowed') }
		}
		const token = stringField(body, 'token')
		const expiresAt = numberField(body, 'expiresAt')
		const id = stringField(body, 'id')
		if (token === undefined || expiresAt === undefined || id === undefined) {
			throw new IamTransportError('issueJwt')
		}
		return { ok: true, token, expiresAt, id }
	}

	async revokeKey(input: RevokeKeyInput): Promise<RevokeKeyResult> {
		const body = await this.call('revokeKey', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return { ok: false, reason: oneOf(failure, [...ISSUE_REASONS, 'not_found'], 'not_allowed') }
		}
		const revoked = booleanField(body, 'revoked')
		if (revoked === undefined) {
			throw new IamTransportError('revokeKey')
		}
		return { ok: true, revoked }
	}

	async listPrincipals(input: ListPrincipalsInput): Promise<ListPrincipalsResult> {
		const body = await this.call('listPrincipals', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return { ok: false, reason: oneOf(failure, ISSUE_REASONS, 'not_allowed') }
		}
		const raw = prop(body, 'principals')
		if (!Array.isArray(raw)) {
			throw new IamTransportError('listPrincipals')
		}
		const principals: PrincipalListItem[] = []
		for (const item of raw) {
			const id = stringField(item, 'id')
			const label = stringField(item, 'label')
			const type = stringField(item, 'type')
			if (id === undefined || label === undefined || type === undefined) {
				throw new IamTransportError('listPrincipals')
			}
			const email = prop(item, 'email')
			principals.push({
				id,
				label,
				// Anything but the literal 'service' is a user, matching how the SDK narrows a persona type.
				type: principalType(type),
				email: typeof email === 'string' ? email : null,
				disabled: booleanField(item, 'disabled') ?? false,
			})
		}
		return { ok: true, principals }
	}

	async getJwks(): Promise<Jwks> {
		// `getJwks` takes no input, so an empty object body is the natural call (the server tolerates a
		// wholly empty body too). It goes through `/rpc/*` like every other method rather than the public
		// `/.well-known/jwks.json`, so ONE key and ONE surface serve the whole contract.
		const body = await this.call('getJwks', {})
		const rawKeys = prop(body, 'keys')
		if (!Array.isArray(rawKeys)) {
			throw new IamTransportError('getJwks')
		}
		const keys: PublicJwk[] = []
		for (const raw of rawKeys) {
			const kty = stringField(raw, 'kty')
			if (kty === undefined) {
				throw new IamTransportError('getJwks')
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

	async audit(event: AuditInput): Promise<void> {
		// 204, no body — `audit` returns void over the binding, so there is nothing to decode. A transport
		// failure still throws: an audit row that silently never happened is the one loss an audit trail
		// cannot absorb.
		await this.send('audit', event)
	}

	/** POST one method and return its decoded JSON body. Throws `IamTransportError` on any transport fault. */
	private async call(method: string, input: unknown): Promise<unknown> {
		const response = await this.send(method, input)
		const body: unknown = await response.json().catch(() => MALFORMED)
		if (body === MALFORMED) {
			throw new IamTransportError(method)
		}
		return body
	}

	private async send(method: string, input: unknown): Promise<Response> {
		let response: Response
		try {
			response = await this.fetchImpl(`${this.origin}/rpc/${method}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
					authorization: `Bearer ${this.key}`,
				},
				body: JSON.stringify(input),
				signal: AbortSignal.timeout(this.timeoutMs),
			})
		} catch {
			// Swallow the cause deliberately: a fetch error stringifies the request URL and, on some
			// runtimes, request detail. Only the method name is ever surfaced.
			throw new IamTransportError(method)
		}
		if (!response.ok) {
			throw new IamTransportError(method)
		}
		return response
	}
}

/** The five delegation-path failure reasons `issueKey` / `issueJwt` / `listPrincipals` share. */
const ISSUE_REASONS = ['missing_token', 'invalid_token', 'unknown_principal', 'disabled', 'not_allowed'] as const

/** Distinguishes "the body was not JSON" from a body that decoded to something the readers reject. */
const MALFORMED = Symbol('malformed')

/**
 * The `reason` of a decided negative, or null when the body is an `ok: true` result. A body that is
 * neither (no `ok`, or `ok: false` with no reason) is a contract violation, not a denial — the caller
 * then fails its own success decode and raises `IamTransportError`, which is the fail-closed answer.
 */
function readFailure(body: unknown): string | null {
	if (prop(body, 'ok') !== false) {
		return null
	}
	return stringField(body, 'reason') ?? ''
}

/** The `{ ok: true, token, expiresAt }` half both mint methods share. */
function readMintSuccess(body: unknown, method: string): { ok: true; token: string; expiresAt: number } {
	const token = stringField(body, 'token')
	const expiresAt = numberField(body, 'expiresAt')
	if (token === undefined || token === '' || expiresAt === undefined) {
		throw new IamTransportError(method)
	}
	return { ok: true, token, expiresAt }
}

/**
 * Narrow a wire `reason` to the declared union without a cast. An unrecognised reason degrades to the
 * given fallback, which is ALWAYS a deny reason — an IAM that starts speaking a dialect this client
 * does not know must not be able to talk it into an allow.
 */
function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
	for (const candidate of allowed) {
		if (candidate === value) {
			return candidate
		}
	}
	return fallback
}

function principalType(value: string): PrincipalType {
	return value === 'service' ? 'service' : 'user'
}
