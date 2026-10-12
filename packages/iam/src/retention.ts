/** How long IAM keeps its logs, in days: `auth_log` always expires, `audit_events` only when the operator says so. */
export interface Retention {
	readonly authLogDays: number
	/** Null keeps every audit row: an audit trail that expires is not one unless the operator chose it. */
	readonly auditDays: number | null
}

export const DEFAULT_AUTH_LOG_RETENTION_DAYS = 30

const DAYS = /^[1-9][0-9]{0,4}$/

/**
 * Parse the two retention settings. Unset or empty means the default; anything but a whole number of days from 1 to
 * 99999 is refused, so a typo fails the boot instead of pruning at a value nobody chose.
 */
export function parseRetention(
	raw: { authLogDays: string | undefined; auditDays: string | undefined },
	names: { authLogDays: string; auditDays: string } = { authLogDays: 'AUTH_LOG_RETENTION_DAYS', auditDays: 'AUDIT_RETENTION_DAYS' },
): Retention {
	return {
		authLogDays: parseDays(names.authLogDays, raw.authLogDays) ?? DEFAULT_AUTH_LOG_RETENTION_DAYS,
		auditDays: parseDays(names.auditDays, raw.auditDays),
	}
}

function parseDays(name: string, raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === '') {
		return null
	}
	if (!DAYS.test(raw.trim())) {
		throw new Error(`${name} must be a whole number of days from 1 to 99999`)
	}
	return Number.parseInt(raw.trim(), 10)
}
