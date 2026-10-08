import { describe, expect, test } from 'bun:test'
import { isCanonicalPath, rawRequestTarget, splitRequestTarget } from '../canonical-path'

describe('isCanonicalPath', () => {
	test.each([
		['an empty segment at the start', '//admin/users'],
		['an empty segment in the middle', '/a//b'],
		['an empty segment before a trailing slash', '/admin//'],
		['a lone double slash', '//'],
		['a dot segment', '/a/./b'],
		['a dot-dot segment', '/a/../admin'],
		['a leading dot-dot segment', '/../admin'],
		['an encoded dot-dot segment', '/a/%2e%2e/b'],
		['an upper-case encoded dot-dot segment', '/a/%2E%2E/b'],
		['a half-encoded dot-dot segment', '/a/.%2e/b'],
		['an encoded dot segment', '/a/%2e'],
		['an encoded slash', '/x%2Fy'],
		['a lower-case encoded slash', '/x%2fy'],
		['an encoded backslash', '/x%5Cy'],
		['a literal backslash, which a URL parser reads as a separator', '/a\\..\\admin'],
		['a percent escape of a byte that is not UTF-8', '/files/%FF'],
		['a lone percent sign', '/files/%'],
		['a percent sign without hex digits', '/files/%zz'],
		['a truncated multi-byte escape', '/files/%E0%A4%A'],
		['an empty path', ''],
		['a relative path', 'admin'],
	])('refuses %s', (_name, path) => {
		expect(isCanonicalPath(path)).toBe(false)
	})

	test.each([
		['the root', '/'],
		['a trailing slash, which is significant and matched literally', '/admin/'],
		['the Sentry envelope path', '/api/1/envelope/'],
		['a single segment', '/health'],
		['nested segments', '/api/acme/envelope'],
		['dots inside a segment', '/v1/items.json'],
		['a segment made of three dots', '/a/.../b'],
		['a double-encoded dot-dot segment, which decodes once to a literal name', '/a/%252e%252e/b'],
		['an encoded character that is not a separator', '/files/a%20b'],
		['an encoded multi-byte character', '/files/caf%C3%A9'],
	])('accepts %s', (_name, path) => {
		expect(isCanonicalPath(path)).toBe(true)
	})
})

describe('splitRequestTarget', () => {
	test('splits at the first question mark', () => {
		expect(splitRequestTarget('/a/b?x=1?y')).toEqual({ pathname: '/a/b', search: '?x=1?y' })
		expect(splitRequestTarget('/a/b')).toEqual({ pathname: '/a/b', search: '' })
	})
})

describe('rawRequestTarget', () => {
	test('keeps the path exactly as written', () => {
		expect(rawRequestTarget('https://example.com/a/../admin?x=1')).toEqual({ pathname: '/a/../admin', search: '?x=1' })
		expect(rawRequestTarget('https://example.com//admin/users')).toEqual({ pathname: '//admin/users', search: '' })
		expect(rawRequestTarget('https://example.com:8443/x%2Fy')).toEqual({ pathname: '/x%2Fy', search: '' })
	})

	test('drops the fragment', () => {
		expect(rawRequestTarget('https://example.com/a?x=1#part')).toEqual({ pathname: '/a', search: '?x=1' })
		expect(rawRequestTarget('https://example.com/a#part?x=1')).toEqual({ pathname: '/a', search: '' })
	})

	test('an authority with no path is the root', () => {
		expect(rawRequestTarget('https://example.com')).toEqual({ pathname: '/', search: '' })
		expect(rawRequestTarget('https://example.com?x=1')).toEqual({ pathname: '/', search: '?x=1' })
	})

	test('a backslash after the authority starts a non-canonical path rather than hiding one', () => {
		const target = rawRequestTarget('https://example.com\\..\\admin')
		expect(target.pathname).toBe('\\..\\admin')
		expect(isCanonicalPath(target.pathname)).toBe(false)
	})
})
