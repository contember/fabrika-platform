// A sign-in that proved its first factor and waits for its second. What it would open rides in a signed `__Host-` cookie
// for five minutes, like the OIDC flight: the signature proves IAM wrote it, the prefix that this browser holds it. The
// code form carries nothing of it, so a posted form names no principal and no destination.

import { z } from 'zod'
import { installationConsole, presentationFor } from '../app-presentation'
import { normalizeOrigin } from '../handoff'
import { type ChallengeProblem, secondFactorChallengePage } from '../second-factor-pages'
import type { Services } from '../services'
import { getSigner, verifyInternal } from '../signing'
import { clearCookie, readCookie, serializeCookie } from './cookies'
import type { Handoff } from './handoff'
import { endingFlightCookies } from './oidc-flight'
import type { AuthEnv } from './oidc-flight'

/** Host-only on IAM's host, outside the `__Host-px_` prefix the proxy strips upstream, so no application receives it. */
export const SECOND_FACTOR_COOKIE = '__Host-fabrika_second_factor'

/** Long enough to open an authenticator app and type a code; a sign-in that takes longer proves its first factor again. */
export const SECOND_FACTOR_CHALLENGE_TTL_SECONDS = 5 * 60

/** Audience of the challenge token — never an app id, so it passes as no access token, flight or device cookie. */
const SECOND_FACTOR_AUDIENCE = 'fabrika:iam:second-factor'

/** The login a verified code opens: what `issueSession` was given, less the request's own id. */
export interface PendingLogin {
	readonly principalId: string
	readonly idpSub: string | null
	readonly email: string | null
	readonly authenticationMethod: 'oidc' | 'password'
	readonly redirect: string | null
	readonly reason: string
	readonly handoff: Handoff | null
	/** A password login earns the known-device cookie once it is recorded. */
	readonly rememberDevice: boolean
}

const handoffSchema = z.object({ app: z.string(), returnUrl: z.string(), state: z.string(), challenge: z.string() })
const pendingSchema = z.object({
	sub: z.string().min(1),
	idp: z.string().nullable(),
	em: z.string().nullable(),
	am: z.enum(['oidc', 'password']),
	rd: z.string().nullable(),
	rs: z.string(),
	ho: handoffSchema.nullable(),
	dv: z.boolean(),
})

/** The pending login the request's challenge cookie proves, or null when it is absent, forged, expired or malformed. */
export async function readPendingLogin(env: AuthEnv, request: Request): Promise<PendingLogin | null> {
	const raw = readCookie(request.headers.get('cookie'), SECOND_FACTOR_COOKIE)
	if (raw === null || raw === '') return null
	const parsed = pendingSchema.safeParse(await verifyInternal(await getSigner(env), raw, SECOND_FACTOR_AUDIENCE))
	if (!parsed.success) return null
	const { sub, idp, em, am, rd, rs, ho, dv } = parsed.data
	return { principalId: sub, idpSub: idp, email: em, authenticationMethod: am, redirect: rd, reason: rs, handoff: ho, rememberDevice: dv }
}

/**
 * Answer a first factor with the code form and the cookie that holds the pending login. An OIDC flight is spent here,
 * as on every other end of its callback.
 */
export async function challengeSecondFactor(services: Services, env: AuthEnv, request: Request, pending: PendingLogin): Promise<Response> {
	const token = await (await getSigner(env)).signInternal(
		{
			sub: pending.principalId,
			idp: pending.idpSub,
			em: pending.email,
			am: pending.authenticationMethod,
			rd: pending.redirect,
			rs: pending.reason,
			ho: pending.handoff,
			dv: pending.rememberDevice,
		},
		SECOND_FACTOR_AUDIENCE,
		SECOND_FACTOR_CHALLENGE_TTL_SECONDS,
	)
	const response = await challengePage(services, request, pending)
	response.headers.append(
		'Set-Cookie',
		serializeCookie(SECOND_FACTOR_COOKIE, token, {
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			maxAge: SECOND_FACTOR_CHALLENGE_TTL_SECONDS,
			path: '/',
		}),
	)
	if (pending.authenticationMethod === 'oidc') {
		for (const cookie of endingFlightCookies()) response.headers.append('Set-Cookie', cookie)
	}
	return response
}

/**
 * The code form for `pending`, again with `problem`. Its `form-action` admits the one origin the verified login lands
 * on: the handoff's registered origin, the IAM-chosen landing, or the console for a login with no destination.
 */
export async function challengePage(services: Services, request: Request, pending: PendingLogin, problem?: ChallengeProblem): Promise<Response> {
	const presentation = await presentationFor(services, pending.handoff?.app ?? null, { request })
	const destination = pending.handoff?.returnUrl ?? pending.redirect ?? await installationConsole(services)
	const origin = destination === null ? null : normalizeOrigin(destination)
	return secondFactorChallengePage({
		presentation,
		...(origin === null ? {} : { redirectOrigin: origin }),
		...(problem === undefined ? {} : { problem }),
	})
}

/** The `Set-Cookie` that spends the challenge. */
export function endingChallengeCookie(): string {
	return clearCookie(SECOND_FACTOR_COOKIE, { path: '/' })
}
