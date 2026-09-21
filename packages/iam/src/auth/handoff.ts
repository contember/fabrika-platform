import { AUTH_CALLBACK_PATH, AUTH_CODE_PARAM, AUTH_HANDOFF_STATE_PARAM } from '@fabrika/auth-core'

import { issueAuthCode, normalizeOrigin, resolveReturnUrl } from '../handoff'
import { type Services } from '../services'
import { printable, safeRedirect } from './http'

/**
 * A session handoff in flight ([ADR-0023](../../../../docs/decisions/0023-one-session-per-host.md)):
 * which app the browser came from and where it goes back to. `null` means a login that started on
 * IAM's own host and stays there.
 */
export interface Handoff {
	app: string
	returnUrl: string
	state: string
	challenge: string
}

/**
 * What `?app=` + `?redirect=` turned out to be. `none` is a login with no app at all; `refused`
 * carries the message of a hard 400.
 */
type HandoffReading =
	| { kind: 'none' }
	| { kind: 'handoff'; handoff: Handoff }
	| { kind: 'refused'; message: string }

/**
 * Read `?app=` + `?redirect=` as a handoff, validating the return URL against what that app has
 * registered.
 *
 * **Two outcomes once an app is named**: the registry contains the return address and the browser
 * gets a code, or it does not and this is a `400` that names the address. There is no third path —
 * ADR-0023 retired the shared session cookie, so a handoff is the ONLY way a session reaches an app's
 * host and an app whose registry does not cover its own origin cannot log anyone in. Answering that
 * with a fallback would produce a login that succeeds and lands somewhere the browser has no session,
 * i.e. a loop with nothing logged anywhere; answering with the address is what an operator can act on.
 *
 * `none` survives only for a login with no `?app=` at all — someone opening IAM's own login page.
 */
export async function readHandoff(
	services: Services,
	app: string | null,
	redirect: string | null,
	state: string | null,
	challenge: string | null,
): Promise<HandoffReading> {
	if (app === null || app === '') {
		return { kind: 'none' }
	}
	if (redirect === null || redirect === '') {
		return { kind: 'refused', message: 'no return address was given for this app' }
	}
	if (!validHandoffState(state) || !validHandoffChallenge(challenge)) {
		return { kind: 'refused', message: 'no valid browser handoff proof was given for this app' }
	}
	const returnUrl = await resolveReturnUrl(services, app, redirect)
	if (returnUrl !== null) {
		return { kind: 'handoff', handoff: { app, returnUrl, state, challenge } }
	}
	const origin = normalizeOrigin(redirect) ?? 'that address'
	return { kind: 'refused', message: `${printable(origin)} is not a registered return origin for this app` }
}

/** The handoff a reading carries, or null — after the caller has already answered a `refused`. */
export function handoffOf(reading: HandoffReading): Handoff | null {
	return reading.kind === 'handoff' ? reading.handoff : null
}

/**
 * What a login page or an OIDC flight should carry as its return address: the handoff's validated
 * destination when there is one, otherwise IAM's own origin (`safeRedirect`).
 */
export function handoffRedirectOr(handoff: Handoff | null, raw: string | null, services: Services): string {
	return handoff === null ? safeRedirect(raw, services.config) : handoff.returnUrl
}

/**
 * What the login page needs to know about a handoff: the app id it carries in a hidden field, and the
 * destination origin its `form-action` must admit. The origin is taken from the REGISTERED return URL
 * `readHandoff` resolved, so it is the same value the 302 will use and never a caller's spelling.
 */
export function loginHandoffFields(
	handoff: Handoff | null,
): { app?: string; handoffOrigin?: string; handoffState?: string; handoffChallenge?: string } {
	if (handoff === null) return {}
	const origin = normalizeOrigin(handoff.returnUrl)
	return {
		app: handoff.app,
		handoffState: handoff.state,
		handoffChallenge: handoff.challenge,
		...(origin === null ? {} : { handoffOrigin: origin }),
	}
}

/** Issue the code and build the URL of the app's own callback. */
export async function handoffLocation(services: Services, handoff: Handoff, parentSessionId: string): Promise<string> {
	const issued = await issueAuthCode(services, {
		app: handoff.app,
		parentSessionId,
		returnUrl: handoff.returnUrl,
		challenge: handoff.challenge,
	})
	const callback = new URL(AUTH_CALLBACK_PATH, handoff.returnUrl)
	callback.searchParams.set(AUTH_CODE_PARAM, issued.code)
	callback.searchParams.set(AUTH_HANDOFF_STATE_PARAM, handoff.state)
	return callback.toString()
}

function validHandoffState(value: string | null): value is string {
	return value !== null && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

function validHandoffChallenge(value: string | null): value is string {
	return value !== null && /^[A-Za-z0-9_-]{43}$/.test(value)
}
