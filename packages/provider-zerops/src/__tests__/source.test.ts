import { describe, expect, test } from 'bun:test'
import { isZeropsUploadDestination, normalizeZeropsSourceRepository } from '../index'

const repository = { owner: 'contember', name: 'fabrika-platform' }

describe('native Zerops upload destination policy', () => {
	const prefix = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?'
	const cases = [
		{ name: 'signed query', url: `${prefix}signature=secret`, native: true },
		{ name: 'opaque query', url: `${prefix}x`, native: true },
		{ name: 'ampersand query', url: `${prefix}&`, native: true },
		{ name: 'bare query', url: prefix, native: false },
		{ name: 'no query', url: prefix.slice(0, -1), native: false },
		{ name: 'empty fragment', url: `${prefix}signature=secret#`, native: true },
		{ name: 'nonempty fragment', url: `${prefix}signature=secret#fragment`, native: false },
		{ name: 'space in query', url: `${prefix}signature=sec ret`, native: true },
		{ name: 'tab in query', url: `${prefix}signature=sec\tret`, native: true },
		{ name: 'long query', url: `${prefix}signature=${'x'.repeat(4096)}`, native: true },
		{ name: 'uppercase protocol', url: prefix.replace('https:', 'HTTPS:') + 'x', native: false },
		{ name: 'uppercase host', url: prefix.replace('proxy.app-prg1.zerops.io', 'PROXY.APP-PRG1.ZEROPS.IO') + 'x', native: false },
		{ name: 'explicit HTTPS port', url: prefix.replace('.io/', '.io:443/') + 'x', native: false },
		{ name: 'nondefault port', url: prefix.replace('.io/', '.io:8443/') + 'x', native: false },
		{ name: 'HTTP', url: prefix.replace('https:', 'http:') + 'x', native: false },
		{ name: 'foreign host', url: prefix.replace('proxy.app-prg1.zerops.io', 'attacker.test') + 'x', native: false },
		{ name: 'host suffix', url: prefix.replace('.io/', '.io.attacker.test/') + 'x', native: false },
		{ name: 'userinfo', url: prefix.replace('https://', 'https://user:secret@') + 'x', native: false },
		{ name: 'empty userinfo', url: prefix.replace('https://', 'https://@') + 'x', native: false },
		{ name: 'other path', url: prefix.replace('/upload?', '/other?') + 'x', native: false },
		{ name: 'trailing slash', url: prefix.replace('/upload?', '/upload/?') + 'x', native: false },
		{ name: 'encoded path', url: prefix.replace('/upload?', '/%75pload?') + 'x', native: false },
		{ name: 'leading whitespace', url: ` ${prefix}x`, native: false },
		{ name: 'malformed URL', url: 'https://[invalid?secret', native: false },
		{ name: 'empty value', url: '', native: false },
	]

	test.each(cases)('$name is accepted only when it is the native destination', ({ url, native }) => {
		expect(isZeropsUploadDestination(url)).toBe(native)
	})
})

describe('Zerops source repository normalization', () => {
	test('normalizes the only accepted GitHub URL shape', () => {
		expect(normalizeZeropsSourceRepository('https://github.com/Contember/Fabrika-Platform.git')).toEqual(repository)
		expect(normalizeZeropsSourceRepository('github.com/Contember/Fabrika-Platform.git')).toEqual(repository)
		expect(normalizeZeropsSourceRepository('github.com/contember/fabrika-platform')).toEqual(repository)
		expect(normalizeZeropsSourceRepository('https://github.com/Contember/Fabrika-Platform')).toEqual(repository)
	})

	test('allows normalized GitHub repository punctuation including the .github repository', () => {
		expect(normalizeZeropsSourceRepository('https://github.com/Contember/.github')).toEqual({ owner: 'contember', name: '.github' })
		for (const name of ['repo-name', 'repo_name', 'repo.name']) {
			expect(normalizeZeropsSourceRepository(`https://github.com/contember/${name}`)).toEqual({ owner: 'contember', name })
		}
	})

	test.each(['', '.', '..', 'nested/repo', 'repo\nname'])('rejects invalid repository name %p', (name) => {
		expect(() => normalizeZeropsSourceRepository(`https://github.com/contember/${name}`)).toThrow()
	})

	test.each([
		'http://github.com/contember/fabrika-platform',
		'https://gitlab.com/contember/fabrika-platform',
		'https://token@github.com/contember/fabrika-platform',
		'https://github.com/contember/fabrika-platform/tree/main',
		'https://github.com/contember/fabrika-platform?token=secret',
		'https://github.com/contember/fabrika-platform/',
		'https://github.com//contember/fabrika-platform',
		'github.com/contember/fabrika-platform#fragment',
		' github.com/contember/fabrika-platform',
		'github.com/contember/fabrika-platform\n',
		'www.github.com/contember/fabrika-platform',
		'git@github.com:contember/fabrika-platform.git',
	])('rejects arbitrary clone location %s', (url) => {
		expect(() => normalizeZeropsSourceRepository(url)).toThrow()
	})
})
