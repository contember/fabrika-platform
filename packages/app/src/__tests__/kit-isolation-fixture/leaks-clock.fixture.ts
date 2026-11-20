// Leaks a fake clock: it sets the system time and never restores it.

import { setSystemTime, test } from 'bun:test'

test('sets the clock and leaves it set', () => {
	setSystemTime(new Date('2001-01-01T00:00:00Z'))
})
