// The membership transport: what an application on a runtime without an IAM service binding (Zerops) calls instead of
// `PropustkaApplication`'s membership methods (ADR-0022 rule 6). `POST /membership/<method>`, the bearer the
// application's own membership transport key (`FABRIKA_IAM_RPC_KEY` in the application, issued by Control through
// `membershipKeys.issue`).
//
// The key authenticates the transport and PINS THE APPLICATION ID: a call whose `app` is not the key's is refused, so a
// key of `notes@stage` acts for no other application and no other environment. It adds no authority. Every operation
// still resolves its caller from the end user's credential in the body, against that application, and scope creation and
// membership changes still spend the delegation grant the proxy obtained for the request (share links take none). The key is no `credentials` row, so no path that
// resolves a `px_` credential finds it.
//
// Narrower than the binding: no `requestDelegation`. Only the proxy obtains a grant (`/auth/mint/delegation`); an
// application that could request one would spend its caller's authority from any endpoint.
//
// The wire is `@fabrika/auth`'s `HttpIamMembership`. A decided refusal is a 200 `{ ok: false, reason }`; 401 is an
// absent, unknown or expired key, 404 an unknown method, 400 an undecodable body, 405 not a POST, 503 a key lookup that
// failed. The key is never logged.

import type { IamMembershipRpc } from '@fabrika/auth-core'
import { logError } from './log'
import {
	assignMemberSchema,
	createScopeSchema,
	findMemberSchema,
	issueLinkSchema,
	listMembersSchema,
	revokeLinkSchema,
	revokeMemberSchema,
	RpcInputError,
} from './rpc-inputs'
import { hashToken, ISSUED_KEY_FORMAT } from './secret'
import type { Services } from './services'

/** The path the surface is mounted under: `/membership/<method>`, one segment. */
export const MEMBERSHIP_TRANSPORT_PREFIX = '/membership/'

/** The operations an application requests on its caller's behalf, and nothing else. */
export type MembershipTransportRpc = Omit<IamMembershipRpc, 'requestDelegation'>

type Operation = (rpc: MembershipTransportRpc, body: unknown, app: string) => Promise<unknown>

const NOT_ALLOWED = { ok: false, reason: 'not_allowed' } as const

/** Parse the body, then refuse a call for any application but the key's before the operation runs. */
function pinned<I extends { app: string }>(parse: (body: unknown) => I, run: (rpc: MembershipTransportRpc, input: I) => Promise<unknown>): Operation {
	return (rpc, body, app) => {
		const input = parse(body)
		return input.app === app ? run(rpc, input) : Promise.resolve(NOT_ALLOWED)
	}
}

const OPERATIONS: ReadonlyMap<string, Operation> = new Map<string, Operation>([
	['createScope', pinned((body) => createScopeSchema.parse(body), (rpc, input) => rpc.createScope(input))],
	['assignMember', pinned((body) => assignMemberSchema.parse(body), (rpc, input) => rpc.assignMember(input))],
	['revokeMember', pinned((body) => revokeMemberSchema.parse(body), (rpc, input) => rpc.revokeMember(input))],
	['listMembers', pinned((body) => listMembersSchema.parse(body), (rpc, input) => rpc.listMembers(input))],
	['findMember', pinned((body) => findMemberSchema.parse(body), (rpc, input) => rpc.findMember(input))],
	['issueLink', pinned((body) => issueLinkSchema.parse(body), (rpc, input) => rpc.issueLink(input))],
	['revokeLink', pinned((body) => revokeLinkSchema.parse(body), (rpc, input) => rpc.revokeLink(input))],
])

/** Serve one membership call of an application. */
export async function handleMembershipTransport(request: Request, services: Services, rpc: MembershipTransportRpc): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'method not allowed' }), {
			status: 405,
			headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST' },
		})
	}
	const key = bearerOf(request)
	if (key === null) {
		return problem(401, 'unauthorized')
	}
	let app: string | null
	try {
		app = await services.repositories.membershipTransport.appOfKey(await hashToken(key), Math.floor(Date.now() / 1000))
	} catch (err) {
		logError('membership transport: the key lookup failed', err)
		return problem(503, 'unavailable')
	}
	if (app === null) {
		return problem(401, 'unauthorized')
	}
	const method = new URL(request.url).pathname.slice(MEMBERSHIP_TRANSPORT_PREFIX.length)
	const operation = OPERATIONS.get(method)
	if (operation === undefined) {
		return problem(404, 'not found')
	}
	const body = await readJsonBody(request)
	if (body === MALFORMED) {
		return problem(400, 'invalid JSON body')
	}
	try {
		return json(await operation(rpc, body, app))
	} catch (err) {
		if (err instanceof RpcInputError) {
			return problem(400, err.message)
		}
		// Every operation returns a refusal rather than throwing, so this is unexpected; the body may carry a credential.
		logError(`membership transport '${method}' failed`, err)
		return problem(500, 'internal error')
	}
}

function bearerOf(request: Request): string | null {
	const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization')?.trim() ?? '')
	const key = match?.[1] ?? null
	return key !== null && ISSUED_KEY_FORMAT.test(key) ? key : null
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function problem(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

const MALFORMED = Symbol('malformed')

async function readJsonBody(request: Request): Promise<unknown> {
	try {
		return JSON.parse(await request.text())
	} catch {
		return MALFORMED
	}
}
