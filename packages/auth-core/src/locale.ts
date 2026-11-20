// How an application names itself to a person on IAM's pages and e-mails: the language IAM speaks for it and the name
// it shows. The contract declares both; IAM's catalog covers every locale here, so adding one fails its typecheck.

/** The languages IAM renders its pages and its own e-mails in. */
export const LOCALES = ['en', 'cs', 'uk'] as const

export type Locale = (typeof LOCALES)[number]

/** IAM's language for a request that names no application, or one that declares none. */
export const DEFAULT_LOCALE: Locale = 'en'

export function isLocale(value: unknown): value is Locale {
	return LOCALES.some((locale) => locale === value)
}

/**
 * The cookie that names the language a browser reads fabrika's pages in, host-only on whichever host wrote it: IAM's
 * on IAM's host, an application's on its own. An application's proxy passes the value on its host to IAM's sign-in as
 * `LOCALE_PARAM`. It picks words and nothing else: no credential, landing or authority depends on it, and a value
 * that is not a `Locale` counts as none. Its name does not start with `FABRIKA_COOKIE_PREFIX`, so the proxy leaves it
 * on the request it sends an application.
 */
export const LOCALE_COOKIE = '__Host-fabrika_locale'

/** The query parameter IAM's pages read the reader's language from: IAM's own links and the proxy's sign-in bounce. */
export const LOCALE_PARAM = 'locale'

/** The longest display name, in code points: it is a page heading and part of an e-mail subject. */
export const MAX_DISPLAY_NAME_LENGTH = 80

/**
 * Why `value` cannot be an application's display name, or `null` when it can. It is plain text that IAM escapes, so
 * the rule only keeps it one short line: trimmed, non-empty, bounded, without a control character (an e-mail subject
 * carries it).
 */
export function displayNameProblem(value: string): string | null {
	if (value.trim() !== value || value === '') {
		return 'is empty or starts or ends with whitespace'
	}
	if (Array.from(value).length > MAX_DISPLAY_NAME_LENGTH) {
		return `is longer than ${MAX_DISPLAY_NAME_LENGTH} characters`
	}
	if (/\p{Cc}/u.test(value)) {
		return 'contains a control character'
	}
	return null
}
