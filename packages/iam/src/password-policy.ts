export const PASSWORD_MIN_CODE_POINTS = 15
export const PASSWORD_MAX_CODE_POINTS = 256

const COMMON_PASSWORDS = new Set([
	'123456789012345',
	'correcthorsebatterystaple',
	'letmeinletmeinletmein',
	'passwordpassword',
	'qwertyuiopqwerty',
	'welcome123456789',
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

/** Validate only length and whole-password blocklists; do not impose composition rules. */
export function validatePassword(raw: string, context: PasswordPolicyContext = {}): PasswordPolicyResult {
	const password = raw.normalize('NFC')
	const length = Array.from(password).length
	if (length < PASSWORD_MIN_CODE_POINTS) {
		return { ok: false, problem: 'too_short' }
	}
	if (length > PASSWORD_MAX_CODE_POINTS) {
		return { ok: false, problem: 'too_long' }
	}

	const comparable = password.toLocaleLowerCase('en-US')
	if (COMMON_PASSWORDS.has(comparable) || contextPasswords(context).has(comparable)) {
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
