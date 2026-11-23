// The second factor: verifying the code of a sign-in that proved its first factor, and enrolling an authenticator app.
// A TOTP secret is sealed under `FABRIKA_IAM_DATA_KEY` (`src/data-key.ts`); recovery codes are stored as hashes only.

import { IAM_APP } from '../admin/router'
import { type AppPresentation, INSTALLATION_PRESENTATION, installationLanding } from '../app-presentation'
import { openValue, sealValue } from '../data-key'
import type { AuditEventInput, PrincipalRow } from '../db'
import type { RequestContext } from '../env'
import { installationBrand } from '../installation-brand'
import { logError } from '../log'
import { authFailurePage } from '../password-pages'
import { readerLocale } from '../person-locale'
import { sealedValueOf } from '../repositories/second-factors'
import { unixNow } from '../repositories/sql'
import {
	type EnrolPageBase,
	recoveryCodesPage,
	SECOND_FACTOR_ENROL_PATH,
	secondFactorEnrolledPage,
	secondFactorEnrolPage,
	secondFactorIntroPage,
	secondFactorUnavailablePage,
} from '../second-factor-pages'
import { hashToken } from '../secret'
import type { Services } from '../services'
import {
	base32,
	generateRecoveryCodes,
	generateTotpSecret,
	matchingStep,
	otpauthUri,
	parseRecoveryCode,
	parseTotpCode,
	qrCodeDataUri,
	recoveryCodeHash,
} from '../totp'
import { readForm, redirectHeaders, sameOrigin, stringValue } from './http'
import type { AuthEnv } from './oidc-flight'
import { challengePage, type PendingLogin, readPendingLogin } from './second-factor-challenge'
import { administersIam, type CurrentLogin, currentLogin, issueSession, refuseLogin } from './sessions'

/** Codes one account may try in a window before the next waits out the block: a burst, not a person mistyping. */
export const SECOND_FACTOR_MAX_ATTEMPTS = 5
const SECOND_FACTOR_WINDOW_SECONDS = 15 * 60
const SECOND_FACTOR_BLOCK_SECONDS = 15 * 60

/**
 * The code form's POST. The pending login comes from the challenge cookie only. Each attempt is counted per account
 * before the code is checked, from the row the counting statement returns, so a parallel burst gets no more than
 * `SECOND_FACTOR_MAX_ATTEMPTS` checks; the attempt that starts a block writes `iam.second_factor.throttle` to the
 * audit log. Every refusal writes its `auth_log` row; an accepted code opens the login through `issueSession`.
 */
export async function handleSecondFactor(
	request: Request,
	services: Services,
	env: AuthEnv,
	ctx: RequestContext,
	requestId: string,
): Promise<Response> {
	const readerFailure = (): AppPresentation => ({ ...INSTALLATION_PRESENTATION, locale: readerLocale(request) })
	if (!sameOrigin(request, services.config)) {
		return refuseLogin(
			services,
			request,
			{ requestId, principalId: null, reason: 'login_cross_origin' },
			() => authFailurePage(readerFailure(), { kind: 'cross_origin' }, 403),
		)
	}
	const pending = await readPendingLogin(env, request)
	if (pending === null) {
		return refuseLogin(
			services,
			request,
			{ requestId, principalId: null, reason: 'second_factor_expired' },
			() => authFailurePage(readerFailure(), { kind: 'second_factor_expired' }, 400),
		)
	}
	// The held login is up to five minutes old: a principal disabled, or a method switched off, since then signs in no more.
	const principal = await services.repositories.principals.getPrincipalById(pending.principalId)
	const methodEnabled = pending.authenticationMethod === 'oidc'
		? services.config.authentication.oidc.enabled
		: services.config.authentication.password.enabled
	if (principal === null || principal.disabled_at !== null || !methodEnabled) {
		return refuseLogin(
			services,
			request,
			{ requestId, principalId: principal === null ? null : pending.principalId, reason: 'second_factor_expired' },
			() => authFailurePage(readerFailure(), { kind: 'second_factor_expired' }, 400),
		)
	}
	const form = await readForm(request)
	const submitted = stringValue(form?.get('code') ?? null) ?? ''
	const refuse = (reason: 'second_factor_invalid' | 'second_factor_throttled', problem: 'invalid' | 'throttled' | 'app_codes_unavailable') =>
		refuseLogin(services, request, { requestId, principalId: pending.principalId, reason }, () => challengePage(services, request, pending, problem))

	const attempt = await countAttempt(services, pending.principalId, requestId)
	if (attempt === 'blocked') return refuse('second_factor_throttled', 'throttled')

	const outcome = await verifySecondFactor(services, pending, submitted, requestId)
	if (outcome === 'app_codes_unavailable') return refuse('second_factor_invalid', 'app_codes_unavailable')
	if (outcome === 'invalid') return refuse('second_factor_invalid', 'invalid')

	await services.repositories.passwords.clearLoginFailures(await attemptKey(pending.principalId))
	return issueSession(request, services, env, ctx, {
		principalId: pending.principalId,
		idpSub: pending.idpSub,
		email: pending.email,
		authenticationMethod: pending.authenticationMethod,
		redirect: pending.redirect,
		reason: pending.reason,
		requestId,
		handoff: pending.handoff,
		rememberDevice: pending.rememberDevice,
		secondFactor: 'verified',
	})
}

function attemptKey(principalId: string): Promise<string> {
	return hashToken(`second-factor:account:${principalId}`)
}

/**
 * Count one attempt and decide from the row the counting statement returns. The attempt that turns the bucket from
 * open to blocked records the burst; the ones refused after it do not, so a burst is one audit row.
 */
async function countAttempt(services: Services, principalId: string, requestId: string): Promise<'admitted' | 'blocked'> {
	const key = await attemptKey(principalId)
	const now = unixNow()
	const before = await services.repositories.passwords.getLoginThrottle(key)
	const row = await services.repositories.passwords.recordLoginFailure({
		loginKeyHash: key,
		windowSeconds: SECOND_FACTOR_WINDOW_SECONDS,
		// The attempt that reaches the limit is the first one refused, so the limit is one past the admitted attempts.
		maxAttempts: SECOND_FACTOR_MAX_ATTEMPTS + 1,
		blockSeconds: SECOND_FACTOR_BLOCK_SECONDS,
	})
	if ((row.blocked_until ?? 0) <= now) return 'admitted'
	if ((before?.blocked_until ?? 0) <= now) {
		await services.repositories.audit.writeAuditEvent(selfEvent(requestId, principalId, 'iam.second_factor.throttle', {
			attempts: SECOND_FACTOR_MAX_ATTEMPTS,
			blockedUntil: row.blocked_until,
		}))
	}
	return 'blocked'
}

/**
 * A six-digit code is checked against the sealed secret and accepted once per time step; anything shaped like a
 * recovery code spends one. A code the data key cannot check (unset, or a key that does not open the secret) is
 * `app_codes_unavailable`, so a recovery code still signs the person in.
 */
async function verifySecondFactor(
	services: Services,
	pending: PendingLogin,
	submitted: string,
	requestId: string,
): Promise<'verified' | 'invalid' | 'app_codes_unavailable'> {
	const code = parseTotpCode(submitted)
	if (code !== null) {
		const factor = await services.repositories.secondFactors.get(pending.principalId)
		if (factor === null || factor.confirmed_at === null) return 'invalid'
		if (services.dataKey === null) return 'app_codes_unavailable'
		let secret: Uint8Array<ArrayBuffer>
		try {
			secret = await openValue(services.dataKey, pending.principalId, sealedValueOf(factor))
		} catch (err) {
			logError(`the authenticator of request '${requestId}' could not be opened with FABRIKA_IAM_DATA_KEY`, err)
			return 'app_codes_unavailable'
		}
		const step = await matchingStep(secret, code, unixNow(), factor.last_step)
		if (step === null) return 'invalid'
		return await services.repositories.secondFactors.acceptStep(pending.principalId, step) ? 'verified' : 'invalid'
	}
	if (parseRecoveryCode(submitted) !== null) {
		const spent = await services.repositories.secondFactors.spendRecoveryCode(
			pending.principalId,
			await recoveryCodeHash(pending.principalId, submitted),
			selfEvent(requestId, pending.principalId, 'iam.second_factor.recovery_code.use'),
		)
		return spent ? 'verified' : 'invalid'
	}
	return 'invalid'
}

/**
 * Enrolment, on IAM's host, for a signed-in principal that administers (`administersIam`). `GET` shows the state;
 * `POST step=start` seals a new secret that waits for its first code and shows it; `POST step=confirm` checks that
 * code, confirms the factor, replaces the recovery codes and records `iam.second_factor.enrol` in one transaction, and
 * shows the codes once. A confirmed factor is never replaced here: only an administrator's reset removes it.
 */
export async function handleSecondFactorEnrolment(request: Request, services: Services, requestId: string): Promise<Response> {
	const locale = readerLocale(request)
	const readerFailure: AppPresentation = { ...INSTALLATION_PRESENTATION, locale }
	if (request.method === 'POST' && !sameOrigin(request, services.config)) {
		return authFailurePage(readerFailure, { kind: 'cross_origin' }, 403)
	}
	const login = await currentLogin(request, services)
	if (login === null) {
		if (request.method === 'POST') return authFailurePage(readerFailure, { kind: 'second_factor_not_allowed' }, 403)
		const back = new URL(SECOND_FACTOR_ENROL_PATH, services.config.issuer).toString()
		return new Response(null, { status: 302, headers: redirectHeaders(`/auth/login?redirect=${encodeURIComponent(back)}`) })
	}
	if (!await administersIam(services, login.principal.id)) {
		return authFailurePage(readerFailure, { kind: 'second_factor_not_allowed' }, 403)
	}
	const brand = await installationBrand(services)
	const page = { brand, locale }
	const status = await services.repositories.secondFactors.status(login.principal.id)
	if (status.confirmedAt !== null) {
		return secondFactorEnrolledPage({ ...page, confirmedAt: status.confirmedAt, recoveryCodesLeft: status.recoveryCodesLeft })
	}
	const dataKey = services.dataKey
	if (dataKey === null) return secondFactorUnavailablePage(page)
	if (request.method === 'GET') return secondFactorIntroPage(page)

	const form = await readForm(request)
	const step = stringValue(form?.get('step') ?? null)
	if (step === 'start') {
		const secret = generateTotpSecret()
		if (!await services.repositories.secondFactors.begin(login.principal.id, await sealValue(dataKey, login.principal.id, secret))) {
			return authFailurePage(readerFailure, { kind: 'second_factor_unavailable' }, 409)
		}
		return enrolPage(services, login, secret, page)
	}
	if (step !== 'confirm') return authFailurePage(readerFailure, { kind: 'malformed_form' }, 400)

	const factor = await services.repositories.secondFactors.get(login.principal.id)
	if (factor === null) return secondFactorIntroPage(page)
	let secret: Uint8Array<ArrayBuffer>
	try {
		secret = await openValue(dataKey, login.principal.id, sealedValueOf(factor))
	} catch (err) {
		logError(`a waiting authenticator could not be opened for request '${requestId}'`, err)
		return authFailurePage(readerFailure, { kind: 'second_factor_unavailable' }, 503)
	}
	const code = parseTotpCode(stringValue(form?.get('code') ?? null) ?? '')
	const matched = code === null ? null : await matchingStep(secret, code, unixNow(), null)
	if (matched === null) return enrolPage(services, login, secret, page, true)

	const codes = generateRecoveryCodes()
	const confirmed = await services.repositories.secondFactors.confirm(
		{
			principalId: login.principal.id,
			ciphertext: factor.ciphertext,
			step: matched,
			recoveryCodeHashes: await Promise.all(codes.map((recovery) => recoveryCodeHash(login.principal.id, recovery))),
		},
		selfEvent(requestId, login.principal.id, 'iam.second_factor.enrol', { recoveryCodes: codes.length }),
	)
	if (!confirmed) return authFailurePage(readerFailure, { kind: 'second_factor_unavailable' }, 409)
	return recoveryCodesPage({ ...page, codes, landing: await installationLanding(services) })
}

function enrolPage(services: Services, login: CurrentLogin, secret: Uint8Array<ArrayBuffer>, page: EnrolPageBase, invalidCode?: boolean): Response {
	const uri = otpauthUri({ issuer: new URL(services.config.issuer).hostname, account: accountName(login.principal), secret })
	return secondFactorEnrolPage({ ...page, qrCode: qrCodeDataUri(uri), key: base32(secret), ...(invalidCode === true ? { invalidCode } : {}) })
}

/** What the authenticator app lists the entry as: the person's sign-in address, as the person knows it. */
function accountName(principal: PrincipalRow): string {
	return principal.label ?? principal.email ?? principal.id
}

/** A principal's own change to its second factor: by it, about it, with no email in it. */
function selfEvent(requestId: string, principalId: string, action: string, metadata?: unknown): AuditEventInput {
	return {
		requestId,
		principalId,
		principalLabel: principalId,
		app: IAM_APP,
		action,
		resourceType: 'principal',
		resourceId: principalId,
		...(metadata === undefined ? {} : { metadata }),
	}
}
