import { describe, expect, test } from 'bun:test'
import { readRunnerEnvironment } from './bootstrap-runner'

describe('runner bootstrap environment', () => {
	test('uses the Control environment name', () => {
		expect(readRunnerEnvironment({ FABRIKA_CONTROL_ENV: 'stage' })).toBe('stage')
	})

	test('defaults to prod when it is unset', () => {
		expect(readRunnerEnvironment({})).toBe('prod')
	})
})
