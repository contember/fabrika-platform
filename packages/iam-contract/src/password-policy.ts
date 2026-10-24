// The installation's password policy (ADR-0020): one minimum length for every principal of the installation, which an
// installation administrator may lower from the default down to the runtime's floor. IAM checks every value again; the
// console reads these numbers only to say what IAM will accept.

/** The minimum of an installation that never set one: NIST SP 800-63B's for a password that is the only factor. */
export const PASSWORD_DEFAULT_MIN_LENGTH = 15

/**
 * The lowest minimum IAM accepts on a runtime whose verifiers meet OWASP's PBKDF2 cost. Below it a password is a PIN, and
 * no throttle makes it one a person can be trusted with.
 */
export const PASSWORD_MIN_LENGTH_FLOOR = 4

/** The most code points a password may have, whatever the minimum. */
export const PASSWORD_MAX_LENGTH = 256

/** Below this NIST asks for a second factor, which IAM does not have; the console says so. */
export const PASSWORD_SINGLE_FACTOR_FLOOR = 8

/** The password policy as IAM applies it now. */
export interface PasswordPolicyDto {
	/** The minimum length in Unicode code points that IAM applies to every new password. */
	minLength: number
	/** The minimum of an installation that never set one, `PASSWORD_DEFAULT_MIN_LENGTH`. */
	defaultMinLength: number
	/**
	 * The lowest minimum this IAM accepts. `PASSWORD_MIN_LENGTH_FLOOR` where verifiers meet OWASP's PBKDF2 cost; the
	 * default on a runtime whose cost is lower (a Cloudflare Worker, backlog 201), where a short password is cheap to
	 * crack offline.
	 */
	minLengthFloor: number
	/** The most code points a password may have. */
	maxLength: number
	/** Whether the installation enables password sign-in at all; the minimum waits for it when it does not. */
	passwordEnabled: boolean
	/** When an administrator last changed the minimum, in epoch seconds; null when nobody ever did. */
	updatedAt: number | null
}

export interface SetPasswordPolicyRequest {
	/** A whole number from `minLengthFloor` to `maxLength`. */
	minLength: number
}
