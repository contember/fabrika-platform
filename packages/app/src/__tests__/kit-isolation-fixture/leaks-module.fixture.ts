// Leaks a module's state: it changes a value another file reads.

import { test } from 'bun:test'
import { settings } from './settings'

test('changes a module-level value and leaves it changed', () => {
	settings.mode = 'leaked'
})
