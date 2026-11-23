import type { Locale } from '@fabrika/auth-core'
import { SECOND_FACTOR_ENROL_PATH } from '@fabrika/iam-contract'
import type { InstallationBrand } from '@fabrika/proxy-core/brand'
import { type AppPresentation, localeQuery } from './app-presentation'
import { catalogFor } from './catalog'
import { escapeHtml } from './html'
import { htmlPage } from './password-pages'

export { SECOND_FACTOR_ENROL_PATH }

/** Where a sign-in waiting for its second factor posts the code. */
export const SECOND_FACTOR_PATH = '/auth/second-factor'

/** Why the code form is shown again. */
export type ChallengeProblem = 'invalid' | 'throttled' | 'app_codes_unavailable'

/**
 * The code a sign-in asks for after its first factor. The pending sign-in rides in the challenge cookie, never in the
 * form. A verified code answers the login's own 302, to the handoff's registered origin, which `form-action` admits.
 */
export function secondFactorChallengePage(input: {
	readonly presentation: AppPresentation
	readonly redirectOrigin?: string
	readonly problem?: ChallengeProblem
}): Response {
	const { presentation } = input
	const text = catalogFor(presentation.locale).pages.secondFactor
	const problem = input.problem === undefined
		? ''
		: `<p role="alert" class="error">${
			escapeHtml(input.problem === 'invalid' ? text.invalidCode : input.problem === 'throttled' ? text.throttled : text.appCodesUnavailable)
		}</p>`
	return htmlPage({
		locale: presentation.locale,
		brand: presentation.brand,
		title: text.challengeTitle,
		content: `<h1>${escapeHtml(text.challengeTitle)}</h1>${problem}<p>${escapeHtml(text.challengeText)}</p>
		<form method="post" action="${escapeHtml(`${SECOND_FACTOR_PATH}${localeQuery(presentation)}`)}">
			<label>${
			escapeHtml(text.codeLabel)
		}<input name="code" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" maxlength="32" required autofocus></label>
			<button type="submit">${escapeHtml(text.submit)}</button>
		</form>
		<p><a href="${escapeHtml(`/auth/login${localeQuery(presentation)}`)}">${escapeHtml(text.startOver)}</a></p>`,
		status: input.problem === undefined ? 200 : input.problem === 'throttled' ? 429 : input.problem === 'invalid' ? 401 : 503,
		formActionOrigin: input.redirectOrigin,
	})
}

export interface EnrolPageBase {
	readonly brand: InstallationBrand | null
	readonly locale: Locale
}

/** The start of an enrolment: what two-step sign-in asks of the person, and the button that issues a key. */
export function secondFactorIntroPage(input: EnrolPageBase): Response {
	const text = catalogFor(input.locale).pages.secondFactor
	return htmlPage({
		locale: input.locale,
		brand: input.brand,
		title: text.enrolTitle,
		content: `<h1>${escapeHtml(text.enrolTitle)}</h1><p>${escapeHtml(text.enrolText)}</p>
		<form method="post" action="${SECOND_FACTOR_ENROL_PATH}">
			<button type="submit" name="step" value="start">${escapeHtml(text.start)}</button>
		</form>`,
	})
}

/** The key to enrol, as a QR code and as text, and the form that confirms it with the first code. */
export function secondFactorEnrolPage(
	input: EnrolPageBase & { readonly qrCode: string; readonly key: string; readonly invalidCode?: boolean },
): Response {
	const text = catalogFor(input.locale).pages.secondFactor
	const grouped = input.key.match(/.{1,4}/g)?.join(' ') ?? input.key
	return htmlPage({
		locale: input.locale,
		brand: input.brand,
		title: text.enrolTitle,
		content: `<h1>${escapeHtml(text.enrolTitle)}</h1>${
			input.invalidCode === true ? `<p role="alert" class="error">${escapeHtml(text.invalidCode)}</p>` : ''
		}<p>${escapeHtml(text.scanText)}</p>
		<p><img src="${escapeHtml(input.qrCode)}" alt="QR" width="240" height="240"></p>
		<p>${escapeHtml(text.secretLabel)}: <code>${escapeHtml(grouped)}</code></p>
		<form method="post" action="${SECOND_FACTOR_ENROL_PATH}">
			<label>${
			escapeHtml(text.confirmLabel)
		}<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required autofocus></label>
			<button type="submit" name="step" value="confirm">${escapeHtml(text.confirm)}</button>
		</form>`,
		status: input.invalidCode === true ? 400 : 200,
	})
}

/** The recovery codes, shown once, at the confirmed enrolment. `landing` is where the person continues. */
export function recoveryCodesPage(input: EnrolPageBase & { readonly codes: readonly string[]; readonly landing: string }): Response {
	const text = catalogFor(input.locale).pages.secondFactor
	return htmlPage({
		locale: input.locale,
		brand: input.brand,
		title: text.recoveryTitle,
		content: `<h1>${escapeHtml(text.recoveryTitle)}</h1><p>${escapeHtml(text.recoveryText)}</p>
		<ul>${input.codes.map((code) => `<li><code>${escapeHtml(code)}</code></li>`).join('')}</ul>
		<p><a class="button" href="${escapeHtml(input.landing)}">${escapeHtml(text.continue)}</a></p>`,
	})
}

/** An authenticator is already enrolled: since when, and how many recovery codes are left. */
export function secondFactorEnrolledPage(input: EnrolPageBase & { readonly confirmedAt: number; readonly recoveryCodesLeft: number }): Response {
	const text = catalogFor(input.locale).pages.secondFactor
	const enrolledOn = new Date(input.confirmedAt * 1000).toISOString().slice(0, 10)
	return htmlPage({
		locale: input.locale,
		brand: input.brand,
		title: text.enrolledTitle,
		content: `<h1>${escapeHtml(text.enrolledTitle)}</h1><p>${escapeHtml(text.enrolledText(enrolledOn, input.recoveryCodesLeft))}</p>`,
	})
}

/** The installation holds no data key, so no authenticator can be enrolled. */
export function secondFactorUnavailablePage(input: EnrolPageBase): Response {
	const text = catalogFor(input.locale).pages.secondFactor
	return htmlPage({
		locale: input.locale,
		brand: input.brand,
		title: text.unavailableTitle,
		content: `<h1>${escapeHtml(text.unavailableTitle)}</h1><p>${escapeHtml(text.unavailableText)}</p>`,
		status: 503,
	})
}
