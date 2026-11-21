// A page leaves the person's language on its own host for the sign-in its proxy starts (ADR-0077): a host-only
// `__Host-fabrika_locale` cookie the browser accepts, which the proxy reads and passes to IAM's sign-in.

import { LOCALE_COOKIE, rememberSignInLocale } from '@fabrika/app/client'
import { LOCALE_COOKIE as AUTH_CORE_LOCALE_COOKIE } from '@fabrika/auth-core'
import { afterEach, describe, expect, test } from 'bun:test'
import { localeCookieAssignment } from '../client/locale'

afterEach(() => {
	Reflect.deleteProperty(globalThis, 'document')
})

describe('the sign-in language a page leaves for its proxy', () => {
	test("is the proxy's cookie, with the attributes its __Host- prefix requires and no Domain", () => {
		expect(LOCALE_COOKIE).toBe(AUTH_CORE_LOCALE_COOKIE)
		const [pair, ...attributes] = localeCookieAssignment('uk').split('; ')
		expect(pair).toBe(`${LOCALE_COOKIE}=uk`)
		expect(attributes).toEqual(['Path=/', 'Secure', 'SameSite=Lax', 'Max-Age=31536000'])
	})

	test('null clears it', () => {
		expect(localeCookieAssignment(null)).toBe(`${LOCALE_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`)
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
		expect(written).toEqual([localeCookieAssignment('cs'), localeCookieAssignment(null)])
	})
})
