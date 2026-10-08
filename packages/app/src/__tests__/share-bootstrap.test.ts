// The share SPA's bootstrap, run against a stand-in window: it takes the key out of the fragment before any other
// script runs, removes the fragment from the address, and keeps the key where only `shareKey()` reads it.

import { shareKey } from '@fabrika/app/client'
import { LINK_BOOTSTRAP_SCRIPT } from '@fabrika/app/implement'
import { describe, expect, test } from 'bun:test'

interface FakeWindow {
	readonly location: { hash: string; readonly pathname: string; readonly search: string }
	readonly history: { readonly state: unknown; replaceState(state: unknown, unused: string, url: string): void }
}

function run(hash: string): { window: FakeWindow; replaced: string[]; read: () => unknown } {
	const replaced: string[] = []
	const window: FakeWindow = {
		location: { hash, pathname: '/s/', search: '?x=1' },
		history: {
			state: null,
			replaceState(_state, _unused, url) {
				replaced.push(url)
			},
		},
	}
	new Function('window', LINK_BOOTSTRAP_SCRIPT)(window)
	const read: unknown = Reflect.get(window, '__fabrikaShareKey')
	return { window, replaced, read: () => (typeof read === 'function' ? read() : undefined) }
}

describe('the share bootstrap', () => {
	test('keeps the key of the fragment and removes the fragment from the address', () => {
		const { replaced, read } = run('#px_abcDEF123_-x')
		expect(read()).toBe('px_abcDEF123_-x')
		expect(replaced).toEqual(['/s/?x=1'])
	})

	test('keeps nothing that is not a key, and still removes the fragment', () => {
		const { replaced, read } = run('#token=abc')
		expect(read()).toBeNull()
		expect(replaced).toEqual(['/s/?x=1'])
	})

	test('the key cannot be replaced by a later script', () => {
		const { window, read } = run('#px_key')
		expect(() => Object.defineProperty(window, '__fabrikaShareKey', { value: () => 'px_other' })).toThrow()
		expect(read()).toBe('px_key')
	})
})

describe('shareKey', () => {
	test('reads what the bootstrap kept, and is null outside a share SPA', () => {
		expect(shareKey()).toBeNull()
		Object.defineProperty(globalThis, '__fabrikaShareKey', { value: () => 'px_from_bootstrap', configurable: true })
		try {
			expect(shareKey()).toBe('px_from_bootstrap')
		} finally {
			Reflect.deleteProperty(globalThis, '__fabrikaShareKey')
		}
	})
})
