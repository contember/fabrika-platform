// What Operations' security alerts read of `auth_log` (`IamSignInSignalsRpc`): refused sign-ins that guessed a
// credential, and allowed sign-ins of a principal that administers at IAM. Shared layer: no runtime import.

import { SIGN_IN_SIGNALS_LIMIT, SIGN_IN_SIGNALS_MAX_WINDOW_SECONDS, type SignInSignalsInput, type SignInSignalsResult } from '@fabrika/auth-core'
import { IAM_APP } from './admin/router'
import type { LoginRefusal } from './auth/sessions'
import type { Services } from './services'

/**
 * Which refused sign-ins at IAM count, decided per reason so a new `LoginRefusal` fails the typecheck until someone
 * says whether it is a credential guess. `account`: a password guess, counted for its known account and installation-wide;
 * `installation`: a guess counted installation-wide only; `null`: not a guess (a stale form, a refused handoff, an IdP
 * or configuration failure) and counted nowhere.
 */
export const COUNTED_LOGIN_REFUSALS: Readonly<Record<LoginRefusal, 'account' | 'installation' | null>> = {
	password_invalid: 'account',
	password_throttled: 'account',
	password_malformed: null,
	handoff_refused: null,
	login_cross_origin: null,
	oidc_invalid_state: null,
	oidc_code_exchange_failed: null,
	oidc_invalid_id_token: null,
	oidc_not_admitted: null,
	oidc_disabled: null,
	oidc_unknown_principal: null,
	oidc_external_principal: null,
	local_login_refused: null,
	second_factor_invalid: 'installation',
	second_factor_throttled: 'installation',
	second_factor_expired: null,
}

/**
 * The one refusal outside IAM's own sign-in that counts: a `px_` key `mintFromKey` refused, at any application. Every
 * other application-side refusal (a stale session, a handoff code, an agent grant, a terminal assertion) is not counted.
 */
export const COUNTED_KEY_REFUSAL = 'invalid_key'

function reasonsOf(bucket: 'account' | 'installation'): string[] {
	return Object.entries(COUNTED_LOGIN_REFUSALS).flatMap(([reason, counted]) => counted === bucket ? [reason] : [])
}

const isWindow = (from: number, until: number): boolean =>
	Number.isSafeInteger(from) && Number.isSafeInteger(until) && from >= 0 && from <= until && until - from <= SIGN_IN_SIGNALS_MAX_WINDOW_SECONDS

/** Read the sign-in signals of one window. A window that is not whole seconds, reversed or longer than a day is refused. */
export async function signInSignals(services: Services, input: SignInSignalsInput): Promise<SignInSignalsResult> {
	const { since, refusalsSince, until } = input
	if (!isWindow(since, until) || !isWindow(refusalsSince, until)) return { ok: false, reason: 'invalid_window' }
	const accountReasons = reasonsOf('account')
	const summary = await services.repositories.audit.signInSignals({
		since,
		refusalsSince,
		until,
		app: IAM_APP,
		accountReasons,
		loginReasons: [...accountReasons, ...reasonsOf('installation')],
		keyReason: COUNTED_KEY_REFUSAL,
		limit: SIGN_IN_SIGNALS_LIMIT,
	})
	return { ok: true, ...summary }
}
