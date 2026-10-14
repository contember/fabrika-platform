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
	AssignMemberInput,
	AssignMemberResult,
	AuditInput,
	CreateScopeInput,
	CreateScopeResult,
	DenyDeviceAuthorizationResult,
	FindMemberInput,
	FindMemberResult,
	IamMembershipRpc,
	IamRpc,
	InspectDeviceAuthorizationInput,
	InspectDeviceAuthorizationResult,
	IssueKeyInput,
	IssueKeyResult,
	IssueLinkInput,
	IssueLinkResult,
	Jwks,
	ListAppMembersInput,
	ListAppMembersResult,
	ListMembersInput,
	ListMembersResult,
	ListOwnDeviceAuthorizationsInput,
	ListOwnDeviceAuthorizationsResult,
	ListPrincipalsInput,
	ListPrincipalsResult,
	MembershipFailure,
	MintFromKeyInput,
	MintFromKeyResult,
	MintTokenInput,
	MintTokenResult,
	RequestDelegationInput,
	RequestDelegationResult,
	RevokeKeyInput,
	RevokeKeyResult,
	RevokeLinkInput,
	RevokeLinkResult,
	RevokeMemberInput,
	RevokeMemberResult,
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
const scopeSchema = z.object({ type: z.string(), value: z.string() })
// Every membership success is a `{ ok: true, … }` envelope; a body without one is not an answer.
const okEnvelope = { ok: z.literal(true) }
const delegationSuccessSchema = z.object({ ...okEnvelope, grant: z.string().min(1), expiresAt: z.number().finite() })
const createScopeSuccessSchema = z.object({ ...okEnvelope, scope: scopeSchema, role: z.string() })
const assignSuccessSchema = z.union([
	z.object({ ...okEnvelope, assigned: z.object({ principalId: z.string(), role: z.string() }) }),
	z.object({ ...okEnvelope, invited: z.object({ invitationId: z.string(), role: z.string(), expiresAt: z.number().finite() }) }),
])
const affiliationSchema = z.enum(['internal', 'external'])
const listMembersSuccessSchema = z.object({
	...okEnvelope,
	members: z.array(z.object({
		principalId: z.string(),
		label: z.string().nullable(),
		email: z.string().nullable(),
		// An IAM from before the field answers none: the member's last sign-in is then unknown.
		lastSignInAt: z.number().finite().nullable().default(null),
		roles: z.array(z.string()),
		disabled: z.boolean(),
		affiliation: affiliationSchema,
	})),
	invitations: z.array(z.object({ id: z.string(), email: z.string(), role: z.string(), expiresAt: z.number().finite() })),
})
const listAppMembersSuccessSchema = z.object({
	...okEnvelope,
	members: z.array(z.object({
		principalId: z.string(),
		label: z.string().nullable(),
		email: z.string().nullable(),
		lastSignInAt: z.number().finite().nullable(),
		roles: z.array(z.object({ role: z.string(), scope: scopeSchema.nullable() })),
		disabled: z.boolean(),
		affiliation: affiliationSchema,
	})),
	next: z.string().nullable(),
})
const findMemberSuccessSchema = z.object({
	...okEnvelope,
	member: z.object({ principalId: z.string(), label: z.string().nullable(), disabled: z.boolean(), affiliation: affiliationSchema }).nullable(),
})
const issueLinkSuccessSchema = z.object({ ...okEnvelope, key: z.string().min(1), id: z.string(), expiresAt: z.number().finite() })
const revokedSuccessSchema = z.object(okEnvelope)
const membershipMessageSchema = z.object({ message: z.string().catch('') })

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
	/**
	 * The bearer: the installation's shared secret gating `/rpc/*` for `HttpIamRpc`, or an application's own
	 * membership transport key for `HttpIamMembership` (`FABRIKA_IAM_RPC_KEY` in each). NEVER logged.
	 */
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

export class HttpIamRpc implements IamRpc, IamMembershipRpc {
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
	private readonly endpoint: TransportEndpoint

	constructor(options: HttpIamRpcOptions) {
		this.endpoint = transportEndpoint(options, '/rpc/')
	}

	async mintToken(input: MintTokenInput): Promise<MintTokenResult> {
		const body = await this.call('mintToken', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return {
				ok: false,
				reason: oneOf(failure, ['no_session', 'invalid_session', 'unknown_principal', 'disabled', 'token_too_large'], 'invalid_session'),
			}
		}
		return readMintSuccess(body, 'mintToken')
	}

	async mintFromKey(input: MintFromKeyInput): Promise<MintFromKeyResult> {
		const body = await this.call('mintFromKey', input)
		const failure = readFailure(body)
		if (failure !== null) {
			return { ok: false, reason: oneOf(failure, ['invalid_key', 'unknown_principal', 'disabled', 'token_too_large'], 'invalid_key') }
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

	readonly #membership = new DecodedIamMembership((method, input) => this.call(method, input))

	requestDelegation(input: RequestDelegationInput): Promise<RequestDelegationResult> {
		return this.#membership.requestDelegation(input)
	}

	createScope(input: CreateScopeInput): Promise<CreateScopeResult> {
		return this.#membership.createScope(input)
	}

	assignMember(input: AssignMemberInput): Promise<AssignMemberResult> {
		return this.#membership.assignMember(input)
	}

	revokeMember(input: RevokeMemberInput): Promise<RevokeMemberResult> {
		return this.#membership.revokeMember(input)
	}

	listMembers(input: ListMembersInput): Promise<ListMembersResult> {
		return this.#membership.listMembers(input)
	}

	listAppMembers(input: ListAppMembersInput): Promise<ListAppMembersResult> {
		return this.#membership.listAppMembers(input)
	}

	findMember(input: FindMemberInput): Promise<FindMemberResult> {
		return this.#membership.findMember(input)
	}

	issueLink(input: IssueLinkInput): Promise<IssueLinkResult> {
		return this.#membership.issueLink(input)
	}

	revokeLink(input: RevokeLinkInput): Promise<RevokeLinkResult> {
		return this.#membership.revokeLink(input)
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

	private call(method: string, input: unknown): Promise<unknown> {
		return callJson(this.endpoint, method, input)
	}

	private send(method: string, input: unknown): Promise<Response> {
		return post(this.endpoint, method, input)
	}
}

/** Where one transport POSTs: `{origin}{prefix}<method>` with the key as the bearer. */
interface TransportEndpoint {
	readonly origin: string
	readonly prefix: string
	readonly key: string
	readonly timeoutMs: number
	readonly fetch: FetchLike
}

function transportEndpoint(options: HttpIamRpcOptions, prefix: string): TransportEndpoint {
	return {
		origin: options.origin.replace(/\/+$/, ''),
		prefix,
		key: options.key,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		fetch: options.fetch ?? globalThis.fetch,
	}
}

/** POST one method and return its decoded JSON body. Throws `IamTransportError` on any transport fault. */
async function callJson(endpoint: TransportEndpoint, method: string, input: unknown): Promise<unknown> {
	const response = await post(endpoint, method, input)
	const body: unknown = await response.json().catch(() => MALFORMED)
	if (body === MALFORMED) {
		throw new IamTransportError(method)
	}
	return body
}

async function post(endpoint: TransportEndpoint, method: string, input: unknown): Promise<Response> {
	let response: Response
	try {
		response = await endpoint.fetch(`${endpoint.origin}${endpoint.prefix}${method}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				authorization: `Bearer ${endpoint.key}`,
			},
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(endpoint.timeoutMs),
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

/** The membership operations, by name, as a transport carries them. */
export type IamMembershipMethod = keyof IamMembershipRpc

/**
 * `IamMembershipRpc` over any transport that answers each call with a JSON-shaped body: `HttpIamRpc`, or a Workers
 * binding to IAM's application entrypoint. Every answer is decoded here, so a body that breaks the contract is
 * `IamTransportError`, never a value of the declared type.
 */
export class DecodedIamMembership implements IamMembershipRpc {
	readonly #call: (method: IamMembershipMethod, input: unknown) => Promise<unknown>

	constructor(call: (method: IamMembershipMethod, input: unknown) => Promise<unknown>) {
		this.#call = call
	}

	async requestDelegation(input: RequestDelegationInput): Promise<RequestDelegationResult> {
		const body = await this.#call('requestDelegation', input)
		return readMembershipFailure(body) ?? decode(delegationSuccessSchema, body, 'requestDelegation')
	}

	async createScope(input: CreateScopeInput): Promise<CreateScopeResult> {
		const body = await this.#call('createScope', input)
		return readMembershipFailure(body) ?? decode(createScopeSuccessSchema, body, 'createScope')
	}

	async assignMember(input: AssignMemberInput): Promise<AssignMemberResult> {
		const body = await this.#call('assignMember', input)
		return readMembershipFailure(body) ?? decode(assignSuccessSchema, body, 'assignMember')
	}

	async revokeMember(input: RevokeMemberInput): Promise<RevokeMemberResult> {
		const body = await this.#call('revokeMember', input)
		return readMembershipFailure(body) ?? decode(revokedSuccessSchema, body, 'revokeMember')
	}

	async listMembers(input: ListMembersInput): Promise<ListMembersResult> {
		const body = await this.#call('listMembers', input)
		return readMembershipFailure(body) ?? decode(listMembersSuccessSchema, body, 'listMembers')
	}

	async listAppMembers(input: ListAppMembersInput): Promise<ListAppMembersResult> {
		const body = await this.#call('listAppMembers', input)
		return readMembershipFailure(body) ?? decode(listAppMembersSuccessSchema, body, 'listAppMembers')
	}

	async findMember(input: FindMemberInput): Promise<FindMemberResult> {
		const body = await this.#call('findMember', input)
		return readMembershipFailure(body) ?? decode(findMemberSuccessSchema, body, 'findMember')
	}

	async issueLink(input: IssueLinkInput): Promise<IssueLinkResult> {
		const body = await this.#call('issueLink', input)
		return readMembershipFailure(body) ?? decode(issueLinkSuccessSchema, body, 'issueLink')
	}

	async revokeLink(input: RevokeLinkInput): Promise<RevokeLinkResult> {
		const body = await this.#call('revokeLink', input)
		return readMembershipFailure(body) ?? decode(revokedSuccessSchema, body, 'revokeLink')
	}
}

/**
 * `IamMembershipRpc` over IAM's membership transport, `POST {origin}/membership/<method>` (`@fabrika/iam`'s
 * `src/membership-http.ts`): what an application without an IAM binding calls, with its own membership transport key.
 * IAM serves no `requestDelegation` there, because only the proxy obtains a grant; calling it is `IamTransportError`.
 */
export class HttpIamMembership extends DecodedIamMembership {
	constructor(options: HttpIamRpcOptions) {
		const endpoint = transportEndpoint(options, '/membership/')
		super((method, input) => callJson(endpoint, method, input))
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

const MEMBERSHIP_REASONS = [
	'missing_token',
	'invalid_token',
	'unknown_principal',
	'disabled',
	'not_allowed',
	'invalid_delegation',
	'not_found',
	'last_creator',
	'invitations_disabled',
	'delivery_failed',
	'internal_mailbox',
] as const

/** A membership refusal off the wire. An unknown reason degrades to `not_allowed`, never to an allow. */
function readMembershipFailure(body: unknown): MembershipFailure | null {
	const reason = readFailure(body)
	if (reason === null) {
		return null
	}
	if (reason === 'invalid_request') {
		const message = membershipMessageSchema.safeParse(body)
		return { ok: false, reason, message: message.success ? message.data.message : '' }
	}
	return { ok: false, reason: oneOf(reason, MEMBERSHIP_REASONS, 'not_allowed') }
}

/** Decode a success body, or treat IAM as unreachable: a body that breaks the contract is not an answer. */
function decode<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown, method: string): T {
	const result = schema.safeParse(body)
	if (!result.success) {
		throw new IamTransportError(method)
	}
	return result.data
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
