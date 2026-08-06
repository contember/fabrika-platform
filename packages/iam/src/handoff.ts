/**
 * Cross-host session handoff ([ADR-0021](../../../docs/decisions/0021-exchange-token-session-handoff.md)).
 *
 * IAM authenticates on ITS host and the app lives on another, where no cookie of IAM's can be read.
 * So IAM issues a single-use code bound to `(session, app, return URL)`, the browser carries it to
 * the app's own host, and the proxy there redeems it for an app-bound child session it CAN set.
 *
 * Two rules carry the security of the whole exchange:
 *
 *   1. **A return URL is validated against the app's registered origins, never trusted.** Whoever
 *      can ask for a code decides where the browser goes next, so an unregistered origin is refused
 *      outright — not quietly rewritten to the issuer, which would hide a misconfiguration behind a
 *      redirect loop.
 *   2. **The child session is bound to one app.** The cookie is host-only, so another app cannot
 *      read it; the binding is the second lock, so a value that leaks anyway cannot buy a token for
 *      anything else (`mintToken` enforces it).
 */

import { AUTH_CODE_TTL_SECONDS, type ExchangeAuthCodeInput, type ExchangeAuthCodeResult } from '@fabrika/auth-core'
import { principalStatus } from './db'
import { pkceChallenge, randomToken } from './oidc'
import { normalizeOrigin } from './origin'
import { hashToken } from './secret'
import type { Services } from './services'

/** An issued code and when it dies. The plaintext is returned once and never stored. */
export interface IssuedAuthCode {
	code: string
	expiresAt: number
}

export { normalizeOrigin }

/**
 * Check a proposed return URL against the app's registered origins and return it normalized, or null.
 *
 * The whole URL is rebuilt from its parts rather than echoed: the stored value is what a later
 * redemption redirects the browser to, and reconstructing it means a caller cannot smuggle anything
 * past the origin check in a component we never looked at.
 */
export async function resolveReturnUrl(services: Services, app: string, rawUrl: string): Promise<string | null> {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return null
	}
	const origin = normalizeOrigin(url.toString())
	if (origin === null) {
		return null
	}
	const registered = await services.repositories.handoff.listReturnOrigins(app)
	if (!registered.includes(origin)) {
		return null
	}
	return `${origin}${url.pathname}${url.search}`
}

/** Issue a single-use code for a validated return URL. */
export async function issueAuthCode(
	services: Services,
	input: { app: string; parentSessionId: string; returnUrl: string; challenge: string },
): Promise<IssuedAuthCode> {
	if (!validChallenge(input.challenge)) throw new Error('invalid handoff challenge')
	// The stored hash integrity-binds the public challenge without adding a second persistence field.
	const code = `${randomToken(32)}.${input.challenge}`
	const expiresAt = Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS
	await services.repositories.handoff.issueCode({
		codeHash: await hashToken(code),
		app: input.app,
		parentSessionId: input.parentSessionId,
		returnUrl: input.returnUrl,
		expiresAt,
	})
	return { code, expiresAt }
}

/** The child session id is surfaced separately so the caller can write an `auth_log` row for it. */
export interface ExchangeOutcome {
	result: ExchangeAuthCodeResult
	principalId: string | null
}

/**
 * Redeem a code for an app-bound child session. Consumption is atomic and happens FIRST: a code that
 * fails any later check is still spent, because a code that survives a failed redemption is a code an
 * attacker can keep trying.
 *
 * The child inherits the parent's absolute expiry, so an app session can never outlive the login it
 * came from, and `getActiveSessionByHash` re-checks the parent on every use so revocation reaches it.
 */
export async function exchangeAuthCode(services: Services, input: ExchangeAuthCodeInput): Promise<ExchangeOutcome> {
	const codeHash = await hashToken(input.code)
	const now = Math.floor(Date.now() / 1000)
	const consumed = await services.repositories.handoff.consumeCode(codeHash, now)
	if (consumed === null) {
		// Tell "never existed" from "too late" for the operator's benefit; the caller sees a deny either
		// way, and neither answer confirms anything about a code the caller did not already hold.
		const existing = await services.repositories.handoff.findCode(codeHash)
		const reason = existing === null ? 'invalid_code' : 'expired_code'
		return { result: { ok: false, reason }, principalId: null }
	}
	if (consumed.app !== input.app) {
		return { result: { ok: false, reason: 'wrong_app' }, principalId: null }
	}
	const challenge = challengeFromCode(input.code)
	if (challenge === null || !validVerifier(input.verifier) || await pkceChallenge(input.verifier) !== challenge) {
		return { result: { ok: false, reason: 'invalid_verifier' }, principalId: null }
	}

	// The login must still be usable: a code outliving a logout would resurrect the session it came from.
	const parent = await services.repositories.sessions.getActiveSessionById(consumed.parent_session_id)
	if (parent === null) {
		return { result: { ok: false, reason: 'invalid_code' }, principalId: null }
	}
	const principal = await services.repositories.principals.getPrincipalById(parent.principal_id)
	if (principal === null) {
		return { result: { ok: false, reason: 'unknown_principal' }, principalId: null }
	}
	if (principalStatus(principal) === 'disabled') {
		return { result: { ok: false, reason: 'disabled' }, principalId: principal.id }
	}

	const session = randomToken(32)
	await services.repositories.sessions.createSession({
		tokenHash: await hashToken(session),
		principalId: principal.id,
		idpSub: parent.idp_sub,
		email: parent.email,
		authenticationMethod: parent.authentication_method,
		expiresAt: parent.expires_at,
		app: consumed.app,
		parentSessionId: parent.id,
	})
	return {
		result: { ok: true, session, returnUrl: consumed.return_url, expiresAt: parent.expires_at },
		principalId: principal.id,
	}
}

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/

function validChallenge(value: string): boolean {
	return CHALLENGE_PATTERN.test(value)
}

function validVerifier(value: string): boolean {
	return VERIFIER_PATTERN.test(value)
}

function challengeFromCode(code: string): string | null {
	const separator = code.lastIndexOf('.')
	if (separator === -1) return null
	const challenge = code.slice(separator + 1)
	return validChallenge(challenge) ? challenge : null
}
