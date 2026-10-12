// `IamRpc` over HTTP — the transport a long-running process needs, because it has no service binding.
//
// WHAT THIS IS NOT: it is not a second implementation. `IamRpc` (@fabrika/auth-core) is unchanged and
// this file holds no policy — it decodes a JSON body into the method's input type, calls the SAME
// object `src/rpc.ts` builds, and encodes the result. Add a method to the contract and it must be
// added here too; nothing else moves.
//
// ── AUTHENTICATING THE SURFACE, and why it needs its own answer ───────────────────────────────────
//
// On Workers these methods sit behind a service binding, which is not addressable from outside the
// account: "who may call this" is answered by the topology, so three of the methods authenticate
// no caller at all. `issueKey`/`revokeKey`/`listPrincipals` resolve a caller from a
// forwarded credential and are safe on their own; `audit` takes its app from a verified token but
// trusts the rest of the event, so anyone holding an app's token could write that app's audit rows;
// and `mintToken`/`mintFromKey` are credential-checking oracles worth rate-limiting even though they
// fail closed. Over HTTP the topology guarantees nothing, so it has to be replaced,
// not assumed.
//
// The replacement is a SHARED SECRET on the transport: `Authorization: Bearer <rpcKey>`, compared as
// SHA-256 digests in constant time (`timingSafeEqualHex`), before the body is even parsed. Two
// properties of that choice are deliberate:
//
//   * It is TRANSPORT auth, not caller identity. It says "this request came from inside the
//     deployment", exactly as a service binding does, and nothing more — the per-caller authorization
//     the management RPCs already do is untouched and still runs. Reusing
//     `FABRIKA_IAM_PROVISIONING_KEY` here was rejected for precisely this reason: that key resolves to
//     a synthetic global admin, so sharing it with every RPC client would hand every client admin.
//   * NO KEY MEANS NO SURFACE. An unset key does not mean "open"; it means these routes 404 as if
//     they were never mounted. A misconfigured deploy therefore loses RPC rather than publishing it,
//     and there is no code path in which the check is skipped.
//
// Defence in depth on Zerops, not a substitute for the above: services are not publicly accessible
// until external access is opted into, so the IAM service exposes only its human-facing hostname and
// the RPC hop stays on the project's private network.
//
// ── TWO SURFACES, TWO KEYS ────────────────────────────────────────────────────────────────────────
//
// `/rpc/*`        — the MANAGEMENT surface (`IamRpc` and `IamMembershipRpc`), gated by `rpcKey`.
// `/auth/mint/*`  — the PROXY surface, gated by `proxyKey`: `mintToken`, `mintFromKey`,
//                   `exchangeAuthCode`, which redeems a cross-host handoff code for an app-bound
//                   session, and `requestDelegation`, a grant spent by the caller's token. Paths and
//                   wire shapes are fixed by `packages/proxy-core/src/iam.ts` (`HttpIamGateway`); that
//                   file is the contract.
//
// They are separate secrets on purpose, and the reason is least privilege rather than tidiness. The
// auth proxy is the ONLY publicly-routed component in the deployment, so it is the one most likely to
// be compromised — and it needs exactly those three IAM calls. Say the third one out loud, because it
// is the one that makes the split worth arguing about: a holder of `proxyKey` can turn a live,
// unconsumed handoff code into a SESSION. That is a real capability, and it is still the smaller
// grant — the code is single-use through a conditional UPDATE, stored only as a hash, bound to
// `(session, app, return URL)`, and dead after two minutes, so holding the key without also holding a
// fresh code buys nothing. Handing the proxy the MANAGEMENT key instead would hand it `audit`, which
// proves only the app (from a token) and takes the actor on the caller's word — and the proxy holds a
// token for every app it fronts, so a compromised proxy could forge audit rows for any of them. It could not escalate through
// `issueKey`/`revokeKey`/`listPrincipals` — those resolve a caller from a forwarded
// credential and enforce delegation regardless of the transport key — but the audit trail is exactly
// the thing that must survive a compromise of the edge. One extra env var buys that.
//
// Each key is independent, and each unset key 404s only its own surface: a deployment with a proxy
// and no control plane sets `proxyKey` alone, and vice versa.

import type { IamHandoffRpc, IamMembershipRpc, IamRpc } from '@fabrika/auth-core'
import { parseApproveDeviceAuthorizationInput, parseInspectDeviceAuthorizationInput, parseListOwnDeviceAuthorizationsInput } from '@fabrika/auth-core'
import {
	assignMemberSchema,
	auditSchema,
	createScopeSchema,
	exchangeAuthCodeSchema,
	findMemberSchema,
	issueKeySchema,
	issueLinkSchema,
	listMembersSchema,
	listPrincipalsSchema,
	mintFromKeySchema,
	mintTokenSchema,
	requestDelegationSchema,
	revokeKeySchema,
	revokeLinkSchema,
	revokeMemberSchema,
	RpcInputError,
} from './rpc-inputs'
import { hashToken, timingSafeEqualHex } from './secret'

/** The path everything here is mounted under. `/rpc/<method>`, one segment, no nesting. */
export const RPC_PREFIX = '/rpc/'

/** True when `pathname` addresses the RPC surface — the mount check the server does before routing. */
export function isRpcPath(pathname: string): boolean {
	return pathname === '/rpc' || pathname.startsWith(RPC_PREFIX)
}

/**
 * Serve one RPC call. `rpcKey` is the shared secret; pass it exactly as configured — an empty or
 * absent key disables the surface (404), which is the fail-closed default, not an error state.
 *
 * A method's own failure is a RESULT, not an HTTP error: a denied `issueKey` answers `200` with
 * `{ ok: false, reason }`, because that is what the binding returns and callers must not have to
 * distinguish "denied" from "unreachable". Only transport faults use status codes — 401 (bad key),
 * 404 (no such method / surface disabled), 400 (undecodable body), 405 (not a POST).
 */
export async function handleRpcHttp(request: Request, rpc: IamRpc & IamMembershipRpc, rpcKey: string): Promise<Response> {
	if (rpcKey.trim() === '') {
		return problem(404, 'not found')
	}
	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'method not allowed' }), {
			status: 405,
			headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST' },
		})
	}
	if (!(await authorized(request, rpcKey))) {
		// No `WWW-Authenticate` challenge: there is no interactive credential to prompt for, and the
		// header would advertise the surface to a scanner that guessed the path.
		return problem(401, 'unauthorized')
	}

	const method = new URL(request.url).pathname.slice(RPC_PREFIX.length)
	const body: unknown = await readJsonBody(request)
	if (body === MALFORMED) {
		return problem(400, 'invalid JSON body')
	}

	try {
		switch (method) {
			case 'inspectDeviceAuthorization':
				return json(await rpc.inspectDeviceAuthorization(parseInspectDeviceAuthorizationInput(body) ?? invalid('device input')))
			case 'approveDeviceAuthorization':
				return json(await rpc.approveDeviceAuthorization(parseApproveDeviceAuthorizationInput(body) ?? invalid('device input')))
			case 'denyDeviceAuthorization':
				return json(await rpc.denyDeviceAuthorization(parseInspectDeviceAuthorizationInput(body) ?? invalid('device input')))
			case 'listOwnDeviceAuthorizations':
				return json(await rpc.listOwnDeviceAuthorizations(parseListOwnDeviceAuthorizationsInput(body) ?? invalid('device input')))
			case 'mintToken':
				return json(await rpc.mintToken(mintTokenSchema.parse(body)))
			case 'mintFromKey':
				return json(await rpc.mintFromKey(mintFromKeySchema.parse(body)))
			case 'issueKey':
				return json(await rpc.issueKey(issueKeySchema.parse(body)))
			case 'revokeKey':
				return json(await rpc.revokeKey(revokeKeySchema.parse(body)))
			case 'listPrincipals':
				return json(await rpc.listPrincipals(listPrincipalsSchema.parse(body)))
			case 'getJwks':
				return json(await rpc.getJwks())
			case 'audit':
				await rpc.audit(auditSchema.parse(body))
				// `audit` returns void over the binding, so there is no result to encode.
				return new Response(null, { status: 204 })
			case 'requestDelegation':
				return json(await rpc.requestDelegation(requestDelegationSchema.parse(body)))
			case 'createScope':
				return json(await rpc.createScope(createScopeSchema.parse(body)))
			case 'assignMember':
				return json(await rpc.assignMember(assignMemberSchema.parse(body)))
			case 'revokeMember':
				return json(await rpc.revokeMember(revokeMemberSchema.parse(body)))
			case 'listMembers':
				return json(await rpc.listMembers(listMembersSchema.parse(body)))
			case 'findMember':
				return json(await rpc.findMember(findMemberSchema.parse(body)))
			case 'issueLink':
				return json(await rpc.issueLink(issueLinkSchema.parse(body)))
			case 'revokeLink':
				return json(await rpc.revokeLink(revokeLinkSchema.parse(body)))
			default:
				return problem(404, 'not found')
		}
	} catch (err) {
		if (err instanceof RpcInputError) {
			return problem(400, err.message)
		}
		// The RPC methods fail closed and return a result rather than throwing; anything reaching here
		// is unexpected. Log a message only — an error object can quote values that came off the wire.
		console.error(`rpc '${method}' failed`, err instanceof Error ? err.message : 'unknown error')
		return problem(500, 'internal error')
	}
}

// ── The proxy surface: `/auth/mint/*` ─────────────────────────────────────────
//
// Four endpoints, fixed by `packages/proxy-core/src/iam.ts`: `mintToken`, `mintFromKey`,
// `exchangeAuthCode` and `requestDelegation`. They are the COLD PATH of every request the proxy handles — the first exchange
// of a browser session, a `px_` key, or an ADR-0022 handoff code for a short-lived signed token — and
// everything after that is a local JWKS verification inside the project. Do not change a
// path or a body shape here without changing `HttpIamGateway` in the same commit: a mismatch fails
// closed at runtime (the gateway maps any non-200 to `IamUnavailableError` → a 503 deny), which is
// safe but very hard to read from the outside.
//
// ALWAYS 200 ON A DECIDED OUTCOME, including a denial. That is not laxity — it is the distinction the
// proxy is built on: `{ ok: false, reason }` means "IAM answered: no", a non-200 means "IAM could not
// be consulted". Both deny, but only the second is an incident.

const MINT_PREFIX = '/auth/mint/'
/** Mint from the browser's SSO session cookie value. Body: `MintTokenInput`. */
export const MINT_SESSION_PATH = `${MINT_PREFIX}session`
/** Mint from an opaque `px_` credential (API key / share link). Body: `MintFromKeyInput`. */
export const MINT_KEY_PATH = `${MINT_PREFIX}key`
/** Redeem a cross-host handoff code for an app session (ADR-0022). Body: `ExchangeAuthCodeInput`. */
export const MINT_EXCHANGE_PATH = `${MINT_PREFIX}exchange`
/**
 * A single-use delegation grant for one request to a membership or scope-creating endpoint (ADR-0022 rule 6).
 * Body: `RequestDelegationInput`. On the proxy surface because the proxy obtains it for every such request; the
 * authority is the caller's token in the body, so the proxy key adds none.
 */
export const MINT_DELEGATION_PATH = `${MINT_PREFIX}delegation`

/** True when `pathname` addresses the proxy mint surface. Checked BEFORE the public `/auth/*` routes. */
export function isMintPath(pathname: string): boolean {
	return pathname === MINT_SESSION_PATH || pathname === MINT_KEY_PATH || pathname === MINT_EXCHANGE_PATH || pathname === MINT_DELEGATION_PATH
}

/**
 * Serve one mint call for the proxy. `proxyKey` is the shared secret; empty disables the surface.
 *
 * ON WHY THIS IS NOT PUBLIC. Minting confers nothing the caller does not already hold — you must
 * present a valid session cookie value or a valid `px_` key, and the token you get back carries
 * exactly that credential's resolved permissions for that app. So an open endpoint would not leak
 * authority. What it WOULD do is publish an internet-facing oracle that answers "is this session/key
 * still valid?" for unlimited guesses, and put a DB read, a permission resolution, an ES256 signature
 * and an `auth_log` write behind every anonymous request to the platform's identity service. The
 * credentials are 160/256-bit random so guessing is infeasible, but neither the oracle nor the
 * amplification has any upside: the only intended caller is the proxy, and it can hold a key.
 *
 * ON RATE LIMITING — deliberately NOT done here. Requiring the key removes the anonymous attacker,
 * which is the case that made this an oracle at all; what remains is per-client throttling, and this
 * service cannot identify a client. Behind the project's L7 balancer the peer address is the
 * balancer's, and the forwarded-header behaviour is not something this repo has verified; keying a
 * limiter on a header a caller can set is worse than no limiter, because it looks like protection.
 * The proxy sits in front of the actual client and already caches per session, so that is where a
 * per-client limit belongs. Detection is covered meanwhile: every failed mint writes an `auth_log`
 * deny row with the app and the reason, so a burst is visible in the admin auth log.
 */
export async function handleMintHttp(
	request: Request,
	rpc: IamRpc & IamHandoffRpc & Pick<IamMembershipRpc, 'requestDelegation'>,
	proxyKey: string,
): Promise<Response> {
	if (proxyKey.trim() === '') {
		return problem(404, 'not found')
	}
	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'method not allowed' }), {
			status: 405,
			headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST' },
		})
	}
	if (!(await authorized(request, proxyKey))) {
		return problem(401, 'unauthorized')
	}

	const body: unknown = await readJsonBody(request)
	if (body === MALFORMED) {
		return problem(400, 'invalid JSON body')
	}

	try {
		const path = new URL(request.url).pathname
		if (path === MINT_SESSION_PATH) {
			return json(await rpc.mintToken(mintTokenSchema.parse(body)))
		}
		if (path === MINT_KEY_PATH) {
			return json(await rpc.mintFromKey(mintFromKeySchema.parse(body)))
		}
		if (path === MINT_EXCHANGE_PATH) {
			return json(await rpc.exchangeAuthCode(exchangeAuthCodeSchema.parse(body)))
		}
		if (path === MINT_DELEGATION_PATH) {
			return json(await rpc.requestDelegation(requestDelegationSchema.parse(body)))
		}
		return problem(404, 'not found')
	} catch (err) {
		if (err instanceof RpcInputError) return problem(400, err.message)
		// Both mint methods fail closed and return a result rather than throwing, so this is unreachable
		// in practice. Log a message only — the body carried a credential.
		console.error('mint failed', err instanceof Error ? err.message : 'unknown error')
		return problem(500, 'internal error')
	}
}

/** Constant-time bearer check against the configured key. Compares digests, never the raw secrets. */
async function authorized(request: Request, rpcKey: string): Promise<boolean> {
	const header = request.headers.get('Authorization')
	if (header === null) {
		return false
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim())
	const presented = match?.[1]?.trim()
	if (presented === undefined || presented === '') {
		return false
	}
	// Hashing first makes the comparison fixed-width, so neither length nor prefix leaks by timing.
	return timingSafeEqualHex(await hashToken(presented), await hashToken(rpcKey))
}

// ── Encoding ──────────────────────────────────────────────────────────────────

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } })
}

function problem(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	})
}

/** Distinguishes "the body was not JSON" from "the body decoded to something the decoders will reject". */
const MALFORMED = Symbol('malformed')

async function readJsonBody(request: Request): Promise<unknown> {
	const text = await request.text()
	// An EMPTY body is not an error: `getJwks` takes no input, so `POST /rpc/getJwks` with nothing
	// attached is the natural call. It becomes `undefined`, which every other method's decoder then
	// rejects by naming the field it wanted — a better answer than "invalid JSON".
	if (text.trim() === '') {
		return undefined
	}
	try {
		return JSON.parse(text)
	} catch {
		return MALFORMED
	}
}

function invalid(field: string): never {
	throw new RpcInputError(`invalid or missing field '${field}'`)
}
