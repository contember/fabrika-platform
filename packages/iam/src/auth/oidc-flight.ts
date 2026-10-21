import { z } from 'zod'
import type { AppPresentation } from '../app-presentation'
import { type Env } from '../env'
import { authFailurePage } from '../password-pages'
import { getSigner, verifyInternal } from '../signing'

import { clearCookie } from './cookies'
import type { AuthFailure } from './failure'

/**
 * In-flight OIDC cookie: a SIGNED token carrying state + PKCE verifier + redirect; `__Host-`, 10 min.
 * Outside the `__Host-px_` prefix the proxy strips upstream; host-only on IAM's host, so no application receives it.
 */
export const OIDC_COOKIE = '__Host-fabrika_oidc'

/** The flight's name before it took the `__Host-` prefix. Never read; only cleared, so old copies expire. */
const LEGACY_OIDC_COOKIE = 'px_oidc'

export const OIDC_TTL_SECONDS = 600

/** The only env the auth surface touches directly is the signing config — the JWKS, and the flight. */
export type AuthEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

/** The in-flight OIDC state carried between /auth/login and /auth/callback. */
interface Flight {
	state: string
	verifier: string
	/** Absent for a login with no return address, which lands on the installation's landing. */
	redirect?: string
	/** The handoff app, when this SSO detour started from one (ADR-0022). */
	app?: string
	handoffState?: string
	handoffChallenge?: string
}

/** Audience of the flight token — never an app id, so a flight can never pass as an access token. */
const OIDC_FLIGHT_AUDIENCE = 'fabrika:iam:oidc-flight'

/**
 * SIGN the flight, with IAM's own key, and keep it in a `__Host-` cookie. Both are needed.
 *
 * The `state` match alone is not a CSRF check when whoever writes the cookie also writes `state`.
 * The signature proves IAM issued the flight, but an attacker can start a login of their own and
 * get a validly signed flight too. Cookie-tossing from any host under a shared registrable domain
 * would plant it in the victim's browser ahead of the victim's own, and IAM would issue the victim
 * a session for the ATTACKER'S identity. The browser refuses a `__Host-` cookie that names a
 * `Domain`, so the prefix proves this browser's flight was set by IAM's host.
 */
export async function encodeFlight(env: AuthEnv, flight: Flight): Promise<string> {
	const signer = await getSigner(env)
	return signer.signInternal({ ...flight }, OIDC_FLIGHT_AUDIENCE, OIDC_TTL_SECONDS)
}

const flightSchema = z.object({
	state: z.string(),
	verifier: z.string(),
	redirect: z.string().optional(),
	app: z.string().optional().catch(undefined),
	handoffState: z.string().optional().catch(undefined),
	handoffChallenge: z.string().optional().catch(undefined),
}).transform(({ state, verifier, redirect, app, handoffState, handoffChallenge }, ctx) => {
	if (app === undefined || app === '') return { state, verifier, redirect }
	if (handoffState === undefined || handoffChallenge === undefined) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete handoff' })
		return z.NEVER
	}
	return { state, verifier, redirect, app, handoffState, handoffChallenge }
})

export async function decodeFlight(env: AuthEnv, raw: string | null): Promise<Flight | null> {
	if (!raw) {
		return null
	}
	const payload = await verifyInternal(await getSigner(env), raw, OIDC_FLIGHT_AUDIENCE)
	const parsed = flightSchema.safeParse(payload)
	return parsed.success ? parsed.data : null
}

/** The `Set-Cookie` values that spend the flight, the legacy `/auth` one included. */
export function endingFlightCookies(): string[] {
	return [clearCookie(OIDC_COOKIE), clearCookie(LEGACY_OIDC_COOKIE, { path: '/auth' })]
}

/** A refusal page that also spends the OIDC flight — every terminal callback outcome goes through here. */
export function authFailureEndingFlight(presentation: AppPresentation, failure: AuthFailure, status: number): Response {
	const response = authFailurePage(presentation, failure, status)
	for (const cookie of endingFlightCookies()) {
		response.headers.append('set-cookie', cookie)
	}
	return response
}
