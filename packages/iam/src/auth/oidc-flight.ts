import { z } from 'zod'
import type { AppPresentation } from '../app-presentation'
import { type Env } from '../env'
import { authFailurePage } from '../password-pages'
import { getSigner, verifyInternal } from '../signing'

import { clearCookie } from './cookies'
import type { AuthFailure } from './failure'

/** In-flight OIDC cookie: a SIGNED token carrying state + PKCE verifier + redirect; /auth, 10 min. */
export const OIDC_COOKIE = 'px_oidc'

export const OIDC_TTL_SECONDS = 600

/** The only env the auth surface touches directly is the signing config — the JWKS, and the flight. */
export type AuthEnv = Pick<Env, 'FABRIKA_IAM_SIGNING_KEYS' | 'ENVIRONMENT'>

/** The in-flight OIDC state carried between /auth/login and /auth/callback. */
interface Flight {
	state: string
	verifier: string
	redirect: string
	/** The handoff app, when this SSO detour started from one (ADR-0022). */
	app?: string
	handoffState?: string
	handoffChallenge?: string
}

/** Audience of the flight token — never an app id, so a flight can never pass as an access token. */
const OIDC_FLIGHT_AUDIENCE = 'fabrika:iam:oidc-flight'

/**
 * SIGN the flight, with IAM's own key.
 *
 * The `state` match alone is not a CSRF check when whoever writes the cookie also writes `state`.
 * `Path=/auth` does not isolate it either: cookie-tossing from any host under a shared registrable
 * domain sets a SECOND `px_oidc` the browser also sends, and per RFC 6265 §5.4 the longer-path one
 * comes first — so an attacker could plant their own flight, hand the victim their authorization
 * code, and have IAM issue the victim a session for the ATTACKER'S identity. A signature is what
 * makes "this flight is ours" true rather than assumed.
 */
export async function encodeFlight(env: AuthEnv, flight: Flight): Promise<string> {
	const signer = await getSigner(env)
	return signer.signInternal({ ...flight }, OIDC_FLIGHT_AUDIENCE, OIDC_TTL_SECONDS)
}

const flightSchema = z.object({
	state: z.string(),
	verifier: z.string(),
	redirect: z.string(),
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

/** A refusal page that also spends the OIDC flight — every terminal callback outcome goes through here. */
export function authFailureEndingFlight(presentation: AppPresentation, failure: AuthFailure, status: number): Response {
	const response = authFailurePage(presentation, failure, status)
	response.headers.append('set-cookie', clearCookie(OIDC_COOKIE, { path: '/auth' }))
	return response
}
