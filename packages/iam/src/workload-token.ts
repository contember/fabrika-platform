// `POST /auth/workload/token`: a job or a webhook of a contract application exchanges its own `px_` key for an access
// token (ADR-0022 "Principal kinds"). The key is the whole authority: the route answers only for a workload key of the
// named app, so it is no oracle for any other credential, and the token it signs is accepted by no mount.

import type { MintFromKeyResult } from '@fabrika/auth-core'
import { z } from 'zod'
import type { Env, RequestContext } from './env'
import { logError } from './log'
import type { Services } from './services'
import { mintFromKey } from './tokens'

const WORKLOAD_KINDS = ['job', 'webhook'] as const

function bearerOf(request: Request): string | null {
	const match = /^Bearer\s+(px_\S+)$/i.exec(request.headers.get('Authorization')?.trim() ?? '')
	return match?.[1] ?? null
}

const bodySchema = z.object({ app: z.string().min(1) }).strict()

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

/** A decided outcome is a 200 like the proxy's mint surface: `{ ok: false }` is "IAM said no", not "IAM is down". */
export async function handleWorkloadToken(
	request: Request,
	services: Services,
	env: Env,
	ctx: RequestContext,
	requestId: string,
): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
	}
	const key = bearerOf(request)
	const app = await appOf(request)
	if (app === null) {
		return Response.json({ error: 'the body is { app }' }, { status: 400 })
	}
	let result: MintFromKeyResult = { ok: false, reason: 'invalid_key' }
	let principalId: string | null = null
	let credentialId: string | null = null
	if (key !== null) {
		try {
			;({ result, principalId, credentialId } = await mintFromKey(services, env, { app, key, requestId }, WORKLOAD_KINDS))
		} catch (err) {
			logError(`workload token failed for request '${requestId}'`, err)
		}
	}
	ctx.waitUntil(
		services.repositories.audit.writeAuthLog({
			requestId,
			app,
			kind: 'authenticate',
			principalId,
			credentialId,
			decision: result.ok ? 'allow' : 'deny',
			reason: result.ok ? 'mint_workload_key' : result.reason,
		}),
	)
	return Response.json(result, { headers: { 'cache-control': 'no-store' } })
}
