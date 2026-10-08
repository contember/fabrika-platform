import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'path'
import { resolveDataDir } from '../src/config'
import { healthMatchesDataRoot } from '../src/daemon-lifecycle'

describe('resolveDataDir', () => {
	const home = '/tmp/fabrika-home'

	test('honors an explicit override', () => {
		expect(resolveDataDir({ home, explicit: './custom-data' }))
			.toBe(resolve('./custom-data'))
	})

	test('uses the neutral directory for a new installation', () => {
		expect(resolveDataDir({ home, explicit: '' }))
			.toBe(join(home, '.fabrika'))
	})
})

describe('daemon data-root handshake', () => {
	test('matches normalized session roots and rejects different roots', () => {
		expect(healthMatchesDataRoot(
			{ sessionsDir: '/tmp/fabrika-data/sessions/../sessions' },
			'/tmp/fabrika-data/sessions',
		)).toBe(true)
		expect(healthMatchesDataRoot(
			{ sessionsDir: '/tmp/other/sessions' },
			'/tmp/fabrika-data/sessions',
		)).toBe(false)
	})
})
