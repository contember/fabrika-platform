import { PASSWORD_MAX_LENGTH } from '@fabrika/iam-contract'
import { COMMON_PASSWORD_LIST } from './common-passwords'

export const PASSWORD_MAX_CODE_POINTS = PASSWORD_MAX_LENGTH

/** Long ones the list does not hold, and the Czech ones a short minimum lets through: "heslo" is "password". */
const COMMON_PASSWORDS = new Set([
	'123456789012345',
	'correcthorsebatterystaple',
	'letmeinletmeinletmein',
	'passwordpassword',
	'qwertyuiopqwerty',
	'welcome123456789',
	'heslo',
	'heslo1',
	'heslo12',
	'heslo123',
	'heslo1234',
	'hesloheslo',
	'ahoj',
	'ahoj123',
	'ahojahoj',
	'qwertz',
	'qwertzu',
	'qwertzui',
	'qwertzuiop',
	'asdfgh',
	'yxcvbnm',
])

export interface PasswordPolicyContext {
	readonly email?: string | null
	readonly label?: string | null
}

/** Why a chosen password is refused; the page words it in the person's language. */
export type PasswordProblem = 'too_short' | 'too_long' | 'guessable'

export type PasswordPolicyResult =
	| { readonly ok: true; readonly password: string }
	| { readonly ok: false; readonly problem: PasswordProblem }

/**
 * Validate only length and whole-password blocklists; do not impose composition rules. `minLength` is the installation's
 * (`passwordMinLength`), which every caller reads for the request: there is no default to fall back on by forgetting it.
 */
export function validatePassword(raw: string, minLength: number, context: PasswordPolicyContext = {}): PasswordPolicyResult {
	const password = raw.normalize('NFC')
	const length = Array.from(password).length
	if (length < minLength) {
		return { ok: false, problem: 'too_short' }
	}
	if (length > PASSWORD_MAX_CODE_POINTS) {
		return { ok: false, problem: 'too_long' }
	}

	const comparable = password.toLocaleLowerCase('en-US')
	if (COMMON_PASSWORDS.has(comparable) || COMMON_PASSWORD_LIST.has(comparable) || contextPasswords(context).has(comparable)) {
		return { ok: false, problem: 'guessable' }
	}
	return { ok: true, password }
}

function contextPasswords(context: PasswordPolicyContext): Set<string> {
	const values = new Set<string>()
	addContextValue(values, context.email)
	addContextValue(values, context.label)
	if (context.email) {
		const separator = context.email.lastIndexOf('@')
		if (separator > 0) addContextValue(values, context.email.slice(0, separator))
	}
	return values
}

function addContextValue(values: Set<string>, raw: string | null | undefined): void {
	if (!raw) return
	const value = raw.normalize('NFC').trim().toLocaleLowerCase('en-US')
	if (value !== '') values.add(value)
}
