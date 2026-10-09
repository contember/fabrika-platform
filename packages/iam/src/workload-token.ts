// `POST /auth/workload/token`: a job or a webhook of a contract application exchanges its own `px_` key for an access
// token (ADR-0022 "Principal kinds"). The key is the whole authority: the route answers only for a workload key of the
// named app, so it is no oracle for any other credential, and the token it signs is accepted by no mount.
//
// The route is public, so a request's cost is bounded before any lookup: the key's format first, then the per-client
// bucket the password and device routes use (only where the composition names a trusted client address; without one
// there is no bucket, never a guess), then one lookup by the key's hash. A refusal writes no auth-log row; refusals are
// counted and logged once per interval.

import type { MintFromKeyResult } from '@fabrika/auth-core'
import { z } from 'zod'
import type { Env, RequestContext } from './env'
import { logError } from './log'
import { hashToken, ISSUED_KEY_FORMAT } from './secret'
import type { Services } from './services'
import { mintFromWorkloadKey } from './tokens'

const bodySchema = z.object({ app: z.string().min(1).max(160) }).strict()

/** Generous on purpose: a project's jobs and webhooks may share one egress address, and each mints once per token lifetime. */
const CLIENT_WINDOW_SECONDS = 600
const CLIENT_MAX_ATTEMPTS = 1_000
const CLIENT_BLOCK_SECONDS = 600
const REFUSAL_LOG_INTERVAL_MS = 60_000

const INVALID_KEY: MintFromKeyResult = { ok: false, reason: 'invalid_key' }

/** Refusals since the last summary line, per isolate or process. */
const refusals = { count: 0, since: Date.now() }

function countRefusal(): void {
	refusals.count += 1
	const now = Date.now()
	if (now - refusals.since >= REFUSAL_LOG_INTERVAL_MS) {
		console.warn(`workload token: ${refusals.count} refused exchange(s) in the last ${Math.round((now - refusals.since) / 1000)} s`)
		refusals.count = 0
		refusals.since = now
	}
}

function bearerOf(request: Request): string | null {
	const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization')?.trim() ?? '')
	const key = match?.[1] ?? null
	return key !== null && ISSUED_KEY_FORMAT.test(key) ? key : null
}

async function appOf(request: Request): Promise<string | null> {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return null
	}
	const parsed = bodySchema.safeParse(body)
	return parsed.success ? parsed.data.app : null
}

function decided(result: MintFromKeyResult): Response {
	return Response.json(result, { headers: { 'cache-control': 'no-store' } })
}

function unavailable(): Response {
	return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } })
}

/** One attempt in this client's bucket; true when the client is over it. Counted before the key is looked up. */
async function clientBlocked(services: Services, clientAddress: string | null): Promise<boolean> {
	if (clientAddress === null) return false
	const row = await services.repositories.passwords.recordLoginFailure({
		loginKeyHash: await hashToken(`workload-token:client:${clientAddress}`),
		windowSeconds: CLIENT_WINDOW_SECONDS,
		maxAttempts: CLIENT_MAX_ATTEMPTS,
		blockSeconds: CLIENT_BLOCK_SECONDS,
	})
	return (row.blocked_until ?? 0) > Math.floor(Date.now() / 1000)
}

/**
 * A decided outcome is a 200 like the proxy's mint surface: `{ ok: false }` is "IAM said no". A storage failure is a
 * 503, so the application reports "IAM could not be asked", never a refused key.
 */
export async function handleWorkloadToken(
	request: Request,
	services: Services,
	env: Env,
	ctx: RequestContext,
	requestId: string,
	clientAddress: string | null,
): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
	}
	const app = await appOf(request)
	if (app === null) {
		return Response.json({ error: 'the body is { app }' }, { status: 400 })
	}
	const key = bearerOf(request)
	if (key === null) {
		countRefusal()
		return decided(INVALID_KEY)
	}
	try {
		if (await clientBlocked(services, clientAddress)) {
			countRefusal()
			return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': String(CLIENT_BLOCK_SECONDS) } })
		}
		const { result, principalId, credentialId } = await mintFromWorkloadKey(services, env, { app, key })
		if (!result.ok) {
			countRefusal()
			return decided(result)
		}
		ctx.waitUntil(
			services.repositories.audit.writeAuthLog({
				requestId,
				app,
				kind: 'authenticate',
				principalId,
				credentialId,
				decision: 'allow',
				reason: 'mint_workload_key',
			}),
		)
		return decided(result)
	} catch (err) {
		logError(`workload token failed for request '${requestId}'`, err)
		return unavailable()
	}
}
