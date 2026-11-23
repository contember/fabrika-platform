/**
 * How long an OIDC login lasts before IAM sends its holder back to the provider, in hours. The provider is where an
 * organization blocks a person, so this bounds how long a person blocked there keeps fabrika access.
 */
export const DEFAULT_OIDC_SESSION_HOURS = 12

/** The longest cap: the lifetime of every IAM login (`SESSION_TTL_SECONDS`, 30 days). */
export const MAX_OIDC_SESSION_HOURS = 30 * 24

const HOURS = /^[1-9][0-9]{0,2}$/

/**
 * Parse the cap into seconds. Unset or empty means the default; anything but a whole number of hours from 1 to 720 is
 * refused, so a typo fails the boot instead of capping at a value nobody chose.
 */
export function parseOidcSessionSeconds(raw: string | undefined, name = 'OIDC_SESSION_HOURS'): number {
	if (raw === undefined || raw.trim() === '') {
		return DEFAULT_OIDC_SESSION_HOURS * 3600
	}
	const value = raw.trim()
	if (!HOURS.test(value) || Number.parseInt(value, 10) > MAX_OIDC_SESSION_HOURS) {
		throw new Error(`${name} must be a whole number of hours from 1 to ${MAX_OIDC_SESSION_HOURS}`)
	}
	return Number.parseInt(value, 10) * 3600
}
