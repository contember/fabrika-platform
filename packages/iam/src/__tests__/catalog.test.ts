// Every language IAM speaks has every word. The catalog type already makes a missing key a type error; this walks the
// catalogs at run time too, so a key that exists but renders nothing, or a locale `LOCALES` names that has no catalog,
// fails here, and every branch of every function (each failure, each password problem, each acceptance) is rendered.

import { type InvitationAcceptance, LOCALES } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import type { AuthFailure } from '../auth/failure'
import { type Catalog, catalogFor } from '../catalog'
import type { PasswordProblem } from '../password-policy'

const FAILURES: readonly AuthFailure[] = [
	{ kind: 'no_return_address' },
	{ kind: 'no_handoff_proof' },
	{ kind: 'unregistered_origin', origin: 'https://other.test' },
	{ kind: 'password_disabled' },
	{ kind: 'oidc_disabled' },
	{ kind: 'cross_origin' },
	{ kind: 'malformed_form' },
	{ kind: 'login_unavailable' },
	{ kind: 'logout_unavailable' },
	{ kind: 'oidc_invalid_state' },
	{ kind: 'oidc_exchange_failed' },
	{ kind: 'oidc_invalid_id_token' },
	{ kind: 'not_admitted' },
	{ kind: 'terminal_enrolment_not_allowed' },
	{ kind: 'terminal_enrolment_unavailable' },
	{ kind: 'terminal_completion_refused' },
	{ kind: 'login_refused', reason: 'principal_disabled' },
]
const PROBLEMS: readonly PasswordProblem[] = ['too_short', 'too_long', 'guessable']
const ACCEPTANCES: readonly InvitationAcceptance[] = ['create', 'sign_in', 'no_account']
const EXPIRES_AT = 1_900_000_000

/** Every string a catalog can render, from fixed sample values, by a path that names where it came from. */
function rendered(catalog: Catalog): Map<string, string> {
	const out = new Map<string, string>()
	const walk = (path: string, value: unknown): void => {
		if (typeof value === 'string') {
			out.set(path, value)
		} else if (typeof value === 'object' && value !== null) {
			for (const [key, child] of Object.entries(value)) walk(`${path}.${key}`, child)
		}
	}
	const { pages, messages, applicationMail } = catalog
	walk('pages', pages)
	for (const appName of [null, 'Portal']) {
		out.set(`pages.signIn.title(${appName})`, pages.signIn.title(appName))
		out.set(`pages.chooseAccount.title(${appName})`, pages.chooseAccount.title(appName))
		out.set(`pages.forgot.intro(${appName})`, pages.forgot.intro(appName))
		out.set(`pages.setPassword.shared(${appName})`, pages.setPassword.shared(appName))
		for (const kind of ['enrollment', 'reset'] as const) {
			const message = messages[kind]({ appName, recipient: 'person@example.test', actionUrl: 'https://iam.test/x', expiresAt: EXPIRES_AT })
			walk(`messages.${kind}(${appName})`, message)
		}
	}
	out.set('pages.chooseAccount.continueAs', pages.chooseAccount.continueAs('person@example.test'))
	for (const purpose of ['enrollment', 'reset'] as const) out.set(`pages.setPassword.title(${purpose})`, pages.setPassword.title(purpose))
	out.set('pages.setPassword.rule', pages.setPassword.rule(12, 128))
	for (const problem of PROBLEMS) {
		for (const count of [1, 2, 5, 12, 21, 22, 128]) {
			out.set(`pages.setPassword.problem(${problem}, ${count})`, pages.setPassword.problem(problem, count, count))
		}
	}
	for (const failure of FAILURES) out.set(`pages.failure.text(${failure.kind})`, pages.failure.text(failure))
	out.set('pages.terminal.labelProblem', pages.terminal.labelProblem(64))
	out.set('pages.terminal.enrolledText', pages.terminal.enrolledText('Front desk'))
	out.set('pages.invitation.createText', pages.invitation.createText('person@example.test'))
	out.set('pages.invitation.otherAccountText', pages.invitation.otherAccountText('person@example.test'))
	out.set('pages.invitation.noAccountText', pages.invitation.noAccountText('person@example.test'))
	out.set('pages.invitation.acceptedText', pages.invitation.acceptedText({ role: 'Editor', scope: 'workspace', appName: 'Portal' }))
	for (const acceptance of ACCEPTANCES) {
		for (const [companyLabel, message] of [['', ''], ['Acme', 'Welcome aboard']]) {
			walk(
				`messages.invitation(${acceptance}, ${companyLabel})`,
				messages.invitation({
					appName: 'Portal',
					role: 'Editor',
					scope: 'workspace',
					recipient: 'person@example.test',
					inviterLabel: 'inviter@example.test',
					companyLabel: companyLabel ?? '',
					message: message ?? '',
					actionUrl: 'https://iam.test/accept',
					expiresAt: EXPIRES_AT,
					acceptance,
				}),
			)
		}
	}
	walk('applicationMail.button', applicationMail.button)
	out.set('applicationMail.expiry', applicationMail.expiry(EXPIRES_AT))
	return out
}

describe('the catalog', () => {
	const english = rendered(catalogFor('en'))

	test('names a catalog for every locale', () => {
		for (const locale of LOCALES) expect(catalogFor(locale)).toBeDefined()
	})

	for (const locale of LOCALES) {
		test(`'${locale}' renders every key English renders, none of them empty`, () => {
			const words = rendered(catalogFor(locale))
			expect([...words.keys()].sort()).toEqual([...english.keys()].sort())
			for (const [path, value] of words) {
				expect({ path, empty: value.trim() === '' }).toEqual({ path, empty: false })
			}
		})
	}

	test('every catalog places the action link in each of its own mails', () => {
		for (const locale of LOCALES) {
			const { messages } = catalogFor(locale)
			const reset = messages.reset({ appName: null, recipient: 'p@example.test', actionUrl: 'https://iam.test/r#token=t', expiresAt: EXPIRES_AT })
			expect(reset.text).toContain('https://iam.test/r#token=t')
			expect(reset.html).toContain('https://iam.test/r#token=t')
		}
	})

	test('Ukrainian agrees the number of characters with the count', () => {
		const problem = catalogFor('uk').pages.setPassword.problem
		expect(problem('too_short', 1, 1)).toContain('1 символ.')
		expect(problem('too_short', 2, 2)).toContain('2 символи.')
		expect(problem('too_short', 12, 12)).toContain('12 символів.')
		expect(problem('too_long', 21, 21)).toContain('21 символ.')
		expect(problem('too_long', 128, 128)).toContain('128 символів.')
	})

	test('Ukrainian words are not English left untranslated', () => {
		const words = rendered(catalogFor('uk'))
		// Each rendered value carries Cyrillic; the only Latin is a sample value or a placeholder IAM inserts.
		for (const [path, value] of words) {
			expect({ path, cyrillic: /\p{Script=Cyrillic}/u.test(value) }).toEqual({ path, cyrillic: true })
		}
	})
})
