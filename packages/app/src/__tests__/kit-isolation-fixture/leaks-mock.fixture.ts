// Leaks a mock: it replaces a module another file imports and never restores it.

import { mock, test } from 'bun:test'

test('mocks a module and leaves it mocked', () => {
	mock.module('./settings', () => ({ settings: { mode: 'mocked' } }))
})
