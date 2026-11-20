// The language a page leaves for its proxy's next sign-in bounce (ADR-0077). The proxy reads `LOCALE_COOKIE` on the
// application's host and passes a language IAM speaks to IAM's sign-in as `?locale=`. It picks words only.

import { type Locale, LOCALE_COOKIE } from '@fabrika/auth-core'

/**
 * A year: the cookie is a preference the page renews whenever the person picks a language again. Safari caps a cookie
 * a script writes at seven days, so a page that wants it kept longer there calls `rememberSignInLocale` on each visit.
 */
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60

/**
 * The `document.cookie` assignment that keeps `locale` for this host, or clears it for `null`. The `__Host-` prefix
 * makes the browser require `Secure` and `Path=/` and refuse a `Domain`, so the cookie stays on this host only.
 */
export function signInLocaleCookie(locale: Locale | null): string {
	return locale === null
		? `${LOCALE_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`
		: `${LOCALE_COOKIE}=${locale}; Path=/; Secure; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`
}

/**
 * Remember `locale` as the language IAM's sign-in speaks when this application's proxy next sends the browser there,
 * or forget it with `null`. Call it where the person picks a language. Outside a browser it does nothing.
 */
export function rememberSignInLocale(locale: Locale | null): void {
	const document: unknown = Reflect.get(globalThis, 'document')
	if (typeof document === 'object' && document !== null) {
		Reflect.set(document, 'cookie', signInLocaleCookie(locale))
	}
}
