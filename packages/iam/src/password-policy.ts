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

export type PasswordPolicyResult =
	| { readonly ok: true; readonly password: string }
	| { readonly ok: false; readonly message: string }

/** Validate only length and whole-password blocklists; do not impose composition rules. */
export function validatePassword(raw: string, context: PasswordPolicyContext = {}): PasswordPolicyResult {
	const password = raw.normalize('NFC')
	const length = Array.from(password).length
	if (length < PASSWORD_MIN_CODE_POINTS) {
		return { ok: false, message: `Use at least ${PASSWORD_MIN_CODE_POINTS} characters.` }
	}
	if (length > PASSWORD_MAX_CODE_POINTS) {
		return { ok: false, message: `Use at most ${PASSWORD_MAX_CODE_POINTS} characters.` }
	}

	const comparable = password.toLocaleLowerCase('en-US')
	if (COMMON_PASSWORDS.has(comparable) || contextPasswords(context).has(comparable)) {
		return { ok: false, message: 'Choose a password that is not based on your account details or a common password.' }
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
