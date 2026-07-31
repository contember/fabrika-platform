import { describe, expect, test } from 'bun:test'
import { readRunnerEnvironment } from './bootstrap-runner'

describe('runner bootstrap environment', () => {
	test('uses the canonical Control environment name', () => {
		expect(readRunnerEnvironment({ FABRIKA_CONTROL_ENV: 'stage' })).toBe('stage')
		expect(readRunnerEnvironment({ FABRIKA_CONTROL_ENV: 'stage', VOZKA_ENV: 'legacy' })).toBe('stage')
	})

	test('accepts the deprecated name and defaults when neither is set', () => {
		expect(readRunnerEnvironment({ VOZKA_ENV: 'legacy' })).toBe('legacy')
		expect(readRunnerEnvironment({})).toBe('prod')
	})
})
