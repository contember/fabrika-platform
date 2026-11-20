// A page leaves the person's language on its own host for the sign-in its proxy starts (ADR-0077): a host-only
// `__Host-fabrika_locale` cookie the browser accepts, which the proxy reads and passes to IAM's sign-in.

import { isLocale, LOCALE_COOKIE, LOCALES, rememberSignInLocale, signInLocaleCookie } from '@fabrika/app/client'
import { LOCALE_COOKIE as AUTH_CORE_LOCALE_COOKIE } from '@fabrika/auth-core'
import { afterEach, describe, expect, test } from 'bun:test'

const attributes = (cookie: string) => cookie.split('; ').slice(1)

afterEach(() => {
	Reflect.deleteProperty(globalThis, 'document')
})

describe('the sign-in language a page leaves for its proxy', () => {
	test("is the proxy's cookie, with the attributes its __Host- prefix requires and no Domain", () => {
		expect(LOCALE_COOKIE).toBe(AUTH_CORE_LOCALE_COOKIE)
		const cookie = signInLocaleCookie('uk')
		expect(cookie.split('; ')[0]).toBe(`${LOCALE_COOKIE}=uk`)
		expect(attributes(cookie)).toEqual(['Path=/', 'Secure', 'SameSite=Lax', 'Max-Age=31536000'])
		expect(cookie).not.toContain('Domain')
		expect(cookie).not.toContain('HttpOnly')
	})

	test('null clears it', () => {
		expect(signInLocaleCookie(null)).toBe(`${LOCALE_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`)
	})

	test('is written to the page document, and outside a browser nothing happens', () => {
		expect(() => rememberSignInLocale('cs')).not.toThrow()
		const written: string[] = []
		Reflect.set(globalThis, 'document', {
			set cookie(value: string) {
				written.push(value)
			},
		})
		rememberSignInLocale('cs')
		rememberSignInLocale(null)
		expect(written).toEqual([signInLocaleCookie('cs'), signInLocaleCookie(null)])
	})

	test('a value from the page narrows to a language IAM speaks first', () => {
		expect(LOCALES).toEqual(['en', 'cs', 'uk'])
		expect(['uk', 'de', 'uk-UA'].filter(isLocale)).toEqual(['uk'])
	})
})
