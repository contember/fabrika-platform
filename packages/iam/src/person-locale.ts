// The language a person reads IAM in. An application declares its own (`app_presentation.locale`); a person may have
// one of their own, which an application names on an invitation and IAM keeps (`principals.locale`). Every source is
// a hint for words and nothing else: none of them decides a landing, an origin or an authority.

import { DEFAULT_LOCALE, isLocale, type Locale } from '@fabrika/auth-core'
import { clearCookie, readCookie, serializeCookie } from './auth/cookies'

/**
 * The language a browser last signed in with here, for the pages IAM shows before it knows who is reading: a sign-in
 * page reads it, so a person whose language differs from the application's keeps theirs after the first visit. A
 * sign-in of a person without a language of their own clears it, so a shared browser does not keep the previous
 * person's. Host-only, like every cookie IAM writes, and words only: nothing reads it as a claim about the person.
 */
export const LOCALE_COOKIE = '__Host-fabrika_locale'

/** A year: the cookie is a preference, renewed by each sign-in of a person with a language of their own. */
const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

/** The query parameter of a link or a form IAM builds for a person whose language it knows (`appQuery`). */
export const LOCALE_PARAM = 'locale'

/** The most `Accept-Language` entries read; a browser sends a handful, and a longer list buys nothing. */
const MAX_LANGUAGE_RANGES = 32

/** A stored or submitted value as a locale IAM speaks, or null: a value it does not (or no longer) speak counts as none. */
export function parseLocale(value: string | null | undefined): Locale | null {
	return isLocale(value) ? value : null
}

/**
 * The language a page speaks, from the most specific source that names one IAM speaks:
 *
 * 1. `person`: the reader's own, as IAM stored it for this flow (an invitation's, a password action's, a principal's);
 * 2. `hint`: a link's or a form's `?locale=`, which IAM writes into the links it mails a person whose language it knows;
 * 3. `remembered`: the language the browser last signed in with here (`LOCALE_COOKIE`);
 * 4. `app`: the application's declared language;
 * 5. `browser`: the best `Accept-Language` match;
 * 6. the installation's default.
 *
 * The application's language ranks above the browser's, so an application that declares one keeps every page it
 * showed before; only a language the person was given wins over it.
 */
export function chooseLocale(sources: {
	readonly person?: Locale | null
	readonly hint?: Locale | null
	readonly remembered?: Locale | null
	readonly app?: Locale | null
	readonly browser?: Locale | null
}): Locale {
	return sources.person ?? sources.hint ?? sources.remembered ?? sources.app ?? sources.browser ?? DEFAULT_LOCALE
}

/** The request's own hints: its `?locale=`, the remembered cookie, and its `Accept-Language`. */
export function requestLocales(request: Request | null | undefined): {
	readonly hint: Locale | null
	readonly remembered: Locale | null
	readonly browser: Locale | null
} {
	if (request === null || request === undefined) return { hint: null, remembered: null, browser: null }
	return {
		hint: parseLocale(new URL(request.url).searchParams.get(LOCALE_PARAM)),
		remembered: parseLocale(readCookie(request.headers.get('Cookie'), LOCALE_COOKIE)),
		browser: browserLocale(request.headers.get('Accept-Language')),
	}
}

/** The language of a page that names no application and knows no person: the request's hints, else the default. */
export function readerLocale(request: Request | null | undefined): Locale {
	return chooseLocale(requestLocales(request))
}

/**
 * The best language IAM speaks among an `Accept-Language` header's ranges (RFC 9110 §12.5.4): by weight, ties in the
 * order written, each range matched by its primary subtag (`uk-UA` is `uk`). A range of weight 0, `*` and a malformed
 * weight are skipped. Null when no range names a language IAM speaks.
 */
export function browserLocale(header: string | null): Locale | null {
	if (header === null || header === '') return null
	const ranges = header.split(',', MAX_LANGUAGE_RANGES).flatMap((part, index) => {
		const [range = '', ...parameters] = part.split(';').map((piece) => piece.trim())
		let weight = 1
		for (const parameter of parameters) {
			const match = /^q=([01](?:\.\d{0,3})?)$/i.exec(parameter)
			if (match === null) return []
			weight = Number(match[1])
		}
		const primary = range.toLowerCase().split('-')[0] ?? ''
		return weight > 0 && weight <= 1 && isLocale(primary) ? [{ locale: primary, weight, index }] : []
	})
	ranges.sort((a, b) => b.weight - a.weight || a.index - b.index)
	return ranges[0]?.locale ?? null
}

/**
 * The `Set-Cookie` a sign-in of a person with `locale` (null for none) answers with: it remembers theirs, or clears a
 * language the browser still holds from someone else; null when there is nothing to change.
 */
export function signInLocaleCookie(request: Request, locale: Locale | null): string | null {
	if (locale !== null) {
		return serializeCookie(LOCALE_COOKIE, locale, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS })
	}
	return readCookie(request.headers.get('Cookie'), LOCALE_COOKIE) === null ? null : clearCookie(LOCALE_COOKIE)
}
