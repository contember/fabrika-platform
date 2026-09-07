import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'path'
import { resolveDataDir } from '../src/config'
import { healthMatchesDataRoot } from '../src/daemon-client'
import { daemonSpawnEnvironment } from '../src/daemon-lifecycle'

describe('resolveDataDir', () => {
	const home = '/tmp/fabrika-home'

	test('honors an explicit override', () => {
		expect(resolveDataDir({ home, explicit: './custom-data', exists: () => false }))
			.toBe(resolve('./custom-data'))
	})

	test('uses the neutral directory for a new installation', () => {
		expect(resolveDataDir({ home, explicit: '', exists: () => false }))
			.toBe(join(home, '.fabrika'))
	})

	test('falls back to existing Claude-era state', () => {
		const legacy = join(home, '.claude', 'fabrika')
		expect(resolveDataDir({ home, explicit: '', exists: (path) => path === legacy }))
			.toBe(legacy)
	})

	test('prefers an existing neutral directory when both exist', () => {
		expect(resolveDataDir({ home, explicit: '', exists: () => true }))
			.toBe(join(home, '.fabrika'))
	})
})

describe('daemon data-root handshake', () => {
	test('matches normalized session roots and rejects missing or different roots', () => {
		expect(healthMatchesDataRoot(
			{ ok: true, sessionsDir: '/tmp/fabrika-data/sessions/../sessions' },
			'/tmp/fabrika-data/sessions',
		)).toBe(true)
		expect(healthMatchesDataRoot({ ok: true }, '/tmp/fabrika-data/sessions')).toBe(false)
		expect(healthMatchesDataRoot(
			{ ok: true, sessionsDir: '/tmp/other/sessions' },
			'/tmp/fabrika-data/sessions',
		)).toBe(false)
	})

	test('passes an absolute data root to the daemon child', () => {
		const env = daemonSpawnEnvironment({ TEST_MARKER: 'yes' }, './relative-state')
		expect(env['TEST_MARKER']).toBe('yes')
		expect(env['FABRIKA_DATA_DIR']).toBe(resolve('./relative-state'))
	})
})
