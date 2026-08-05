/**
 * IAM's own cookie (de)serialization (TEST-12).
 *
 * `readCookie` is a hand-rolled parser standing between the network and every session decision, and it
 * had no test of its own. The cases below are the ones a hand-rolled parser gets wrong: a name that is
 * a PREFIX of another (`px_` vs `px_session`), whitespace after the separator, an empty value, and a
 * malformed segment in the middle of an otherwise valid header.
 */

import { SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { clearCookie, readCookie, serializeCookie } from '../auth/cookies'

describe('readCookie', () => {
	test('absent header and absent cookie both read as null', () => {
		expect(readCookie(null, 'px_session')).toBeNull()
		expect(readCookie('', 'px_session')).toBeNull()
		expect(readCookie('other=1', 'px_session')).toBeNull()
	})

	test('reads a value, with or without whitespace around the separator', () => {
		expect(readCookie('px_session=abc', 'px_session')).toBe('abc')
		expect(readCookie('a=1; px_session=abc; b=2', 'px_session')).toBe('abc')
		expect(readCookie('a=1;   px_session=abc  ;b=2', 'px_session')).toBe('abc')
	})

	test('an EMPTY value is an empty string, not null', () => {
		// A cleared cookie the browser has not dropped yet arrives as `name=`. Reading it as null would
		// be harmless here, but reading it as the NEXT cookie's value would not be.
		expect(readCookie('px_session=; other=real', 'px_session')).toBe('')
	})

	test('a name that PREFIXES another does not match it', () => {
		// The one that actually bites: `px_` and `px_session` and `px_token` share a prefix.
		expect(readCookie('px_session_backup=wrong; px_session=right', 'px_session')).toBe('right')
		expect(readCookie('px_session=right', 'px_session_backup')).toBeNull()
		expect(readCookie('px_token=t', 'px_')).toBeNull()
	})

	test('a malformed segment is skipped rather than derailing the parse', () => {
		expect(readCookie('novalue; px_session=abc', 'px_session')).toBe('abc')
		expect(readCookie('px_session=abc; novalue', 'px_session')).toBe('abc')
		expect(readCookie(';;;', 'px_session')).toBeNull()
	})

	test('a value containing `=` is preserved whole', () => {
		expect(readCookie('px_session=a=b=c', 'px_session')).toBe('a=b=c')
	})

	test('the FIRST occurrence wins, deterministically', () => {
		// Duplicate-aware reading is deliberately out of scope (ADR: `__Host-` prefix instead), so what
		// matters is that the behaviour is stated rather than accidental.
		expect(readCookie('px_session=first; px_session=second', 'px_session')).toBe('first')
	})
})

describe('serializeCookie / clearCookie', () => {
	test('a bare cookie defaults to Path=/ and nothing else', () => {
		expect(serializeCookie('px_session', 'abc')).toBe('px_session=abc; Path=/')
	})

	test('every option lands in the header, in a shape a browser accepts', () => {
		expect(
			serializeCookie('px_session', 'abc', {
				maxAge: 3600,
				httpOnly: true,
				secure: true,
				sameSite: 'Lax',
				path: '/auth',
			}),
		).toBe('px_session=abc; Path=/auth; Max-Age=3600; HttpOnly; Secure; SameSite=Lax')
	})

	// There is no `domain` option, and its absence is the point: every cookie IAM writes is host-only,
	// and `__Host-px_session` would be REFUSED by the browser if one were emitted (ADR-0023).
	test('no option can produce a Domain attribute', () => {
		const header = serializeCookie(SESSION_COOKIE, 'abc', { maxAge: 3600, httpOnly: true, secure: true, sameSite: 'Lax' })
		expect(header).toBe(`${SESSION_COOKIE}=abc; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`)
		expect(header).not.toContain('Domain')
	})

	test('`maxAge: 0` is emitted — it is how a cookie is expired, not an absent option', () => {
		expect(serializeCookie('px_session', '', { maxAge: 0 })).toContain('Max-Age=0')
	})

	test('clearCookie expires the value and round-trips back to empty', () => {
		const header = clearCookie('px_session')
		expect(header).toContain('px_session=')
		expect(header).toContain('Max-Age=0')
		// `Secure` is unconditional: a deletion must satisfy the same attribute rules as the cookie it
		// replaces, or the browser keeps the original.
		expect(header).toContain('Secure')
		expect(header).toContain('HttpOnly')
		// What a browser would send back before it drops the cookie.
		expect(readCookie(header.split(';')[0] ?? '', 'px_session')).toBe('')
	})

	test('a serialized cookie reads back as the same value', () => {
		for (const value of ['abc', 'a=b=c', '']) {
			const serialized = serializeCookie('px_session', value, { httpOnly: true, sameSite: 'Lax' })
			expect(readCookie(serialized.split(';')[0] ?? '', 'px_session')).toBe(value)
		}
	})
})
