// How an application names itself to a person on IAM's pages and e-mails: the language IAM speaks for it and the name
// it shows. The contract declares both; IAM's catalog covers every locale here, so adding one fails its typecheck.

/** The languages IAM renders its pages and its own e-mails in. */
export const LOCALES = ['en', 'cs'] as const

export type Locale = (typeof LOCALES)[number]

/** IAM's language for a request that names no application, or one that declares none. */
export const DEFAULT_LOCALE: Locale = 'en'

export function isLocale(value: unknown): value is Locale {
	return LOCALES.some((locale) => locale === value)
}

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
