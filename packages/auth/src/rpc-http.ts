/**
 * `IamRpc` over HTTP — the transport an app needs when it has no Cloudflare service binding.
 *
 * WHAT THIS IS NOT: it is not a second IAM. `IamRpc` (@fabrika/auth-core) is unchanged and this class
 * holds no policy — it POSTs the method's input as JSON, reads the result back, and hands it to the
 * same callers (`Iam`, `IamClient`) the binding serves. Everything downstream of the
 * contract — local token verification, `can()`/`scopedTo()`, delegation checks inside the IAM
 * service — is byte-for-byte the same code on both transports. The ONLY difference is how the
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
 * The SDK caches the fetched JWKS and the tokens minted from `px_` share credentials in `WeakMap`s
 * keyed by THE BINDING OBJECT. A fresh `HttpIamRpc` per request would therefore miss both caches every
 * time and re-fetch the JWKS on every request. Build one for the process's lifetime and put it in the
 * env, the way a binding lives for the isolate's lifetime.
 *
 * The key is a TRANSPORT credential, never a caller identity: it says "this request came from inside
 * the deployment", exactly as a binding's unreachability does. Per-caller authorization still happens
 * inside IAM, from the credential carried in the method's own input. It is never logged.
 */

import type {
	ApproveDeviceAuthorizationInput,
	ApproveDeviceAuthorizationResult,
	AuditInput,
	DenyDeviceAuthorizationResult,
	IamRpc,
	InspectDeviceAuthorizationInput,
	InspectDeviceAuthorizationResult,
	IssueKeyInput,
	IssueKeyResult,
	Jwks,
	ListOwnDeviceAuthorizationsInput,
	ListOwnDeviceAuthorizationsResult,
	ListPrincipalsInput,
	ListPrincipalsResult,
	MintFromKeyInput,
	MintFromKeyResult,
	MintTokenInput,
	MintTokenResult,
	RevokeKeyInput,
	RevokeKeyResult,
} from '@fabrika/auth-core'
import {
	parseApproveDeviceAuthorizationResult,
	parseDenyDeviceAuthorizationResult,
	parseInspectDeviceAuthorizationResult,
	parseListOwnDeviceAuthorizationsResult,
} from '@fabrika/auth-core'
import { parseJwks } from '@fabrika/jwks'
import { z } from 'zod'

const mintSuccessSchema = z.object({ token: z.string().min(1), expiresAt: z.number().finite() })
const issueKeySuccessSchema = z.object({
	token: z.string(),
	id: z.string(),
	principalId: z.string().optional().catch(undefined),
}).transform(({ principalId, ...result }) => ({ ...result, ...(principalId === undefined ? {} : { principalId }) }))
const revokeSuccessSchema = z.object({ revoked: z.boolean() })
const principalsSuccessSchema = z.object({
	principals: z.array(z.object({
		id: z.string(),
		label: z.string(),
		type: z.string().transform((value): 'service' | 'user' => value === 'service' ? 'service' : 'user'),
		email: z.string().nullable().catch(null),
		disabled: z.boolean().catch(false),
	})),
})
const failureSchema = z.object({ ok: z.literal(false), reason: z.string().catch('') })

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
	async inspectDeviceAuthorization(input: InspectDeviceAuthorizationInput): Promise<InspectDeviceAuthorizationResult> {
		const result = parseInspectDeviceAuthorizationResult(await this.call('inspectDeviceAuthorization', input))
		if (!result) throw new IamTransportError('inspectDeviceAuthorization')
		return result
	}
	async approveDeviceAuthorization(input: ApproveDeviceAuthorizationInput): Promise<ApproveDeviceAuthorizationResult> {
		const result = parseApproveDeviceAuthorizationResult(await this.call('approveDeviceAuthorization', input))
		if (!result) throw new IamTransportError('approveDeviceAuthorization')
		return result
	}
	async denyDeviceAuthorization(input: InspectDeviceAuthorizationInput): Promise<DenyDeviceAuthorizationResult> {
		const result = parseDenyDeviceAuthorizationResult(await this.call('denyDeviceAuthorization', input))
		if (!result) throw new IamTransportError('denyDeviceAuthorization')
		return result
	}
	async listOwnDeviceAuthorizations(input: ListOwnDeviceAuthorizationsInput): Promise<ListOwnDeviceAuthorizationsResult> {
		const result = parseListOwnDeviceAuthorizationsResult(await this.call('listOwnDeviceAuthorizations', input))
		if (!result) throw new IamTransportError('listOwnDeviceAuthorizations')
		return result
	}
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
		const result = issueKeySuccessSchema.safeParse(body)
		if (!result.success) {
			throw new IamTransportError('issueKey')
		}
		return { ok: true, ...result.data }
	}

	async revokeKey(input: RevokeKeyInput): Promise<RevokeKeyResult> {
		const body = await this.call('revokeKey', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return { ok: false, reason: oneOf(failure, [...ISSUE_REASONS, 'not_found'], 'not_allowed') }
		}
		const result = revokeSuccessSchema.safeParse(body)
		if (!result.success) {
			throw new IamTransportError('revokeKey')
		}
		return { ok: true, ...result.data }
	}

	async listPrincipals(input: ListPrincipalsInput): Promise<ListPrincipalsResult> {
		const body = await this.call('listPrincipals', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return { ok: false, reason: oneOf(failure, ISSUE_REASONS, 'not_allowed') }
		}
		const result = principalsSuccessSchema.safeParse(body)
		if (!result.success) {
			throw new IamTransportError('listPrincipals')
		}
		return { ok: true, ...result.data }
	}

	async getJwks(): Promise<Jwks> {
		// `getJwks` takes no input, so an empty object body is the natural call (the server tolerates a
		// wholly empty body too). It goes through `/rpc/*` like every other method rather than the public
		// `/.well-known/jwks.json`, so ONE key and ONE surface serve the whole contract.
		const jwks = parseJwks(await this.call('getJwks', {}))
		if (jwks === null) {
			throw new IamTransportError('getJwks')
		}
		return jwks
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

/** The five delegation-path failure reasons `issueKey` / `revokeKey` / `listPrincipals` share. */
const ISSUE_REASONS = ['missing_token', 'invalid_token', 'unknown_principal', 'disabled', 'not_allowed'] as const

/** Distinguishes "the body was not JSON" from a body that decoded to something the readers reject. */
const MALFORMED = Symbol('malformed')

/**
 * Only literal false selects denial; missing or malformed reasons use the operation's deny fallback.
 * Success fields are decoded independently of `ok`, preserving the SDK's tolerant wire contract.
 */
function readFailure(body: unknown): string | null {
	const result = failureSchema.safeParse(body)
	return result.success ? result.data.reason : null
}

/** The `{ ok: true, token, expiresAt }` half both mint methods share. */
function readMintSuccess(body: unknown, method: string): { ok: true; token: string; expiresAt: number } {
	const result = mintSuccessSchema.safeParse(body)
	if (!result.success) {
		throw new IamTransportError(method)
	}
	return { ok: true, ...result.data }
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
