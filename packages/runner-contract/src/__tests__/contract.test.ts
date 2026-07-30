import { describe, expect, test } from 'bun:test'
import { RUNNER_HEALTH_PATH, RUNNER_LOGS_PATH, RUNNER_PORT, RUNNER_RUN_PATH, RUNNER_STATUS_PATH } from '..'

describe('runner transport contract', () => {
	test('uses stable container endpoints', () => {
		expect(RUNNER_PORT).toBe(8080)
		expect(RUNNER_RUN_PATH).toBe('/run')
		expect(RUNNER_LOGS_PATH).toBe('/logs')
		expect(RUNNER_STATUS_PATH).toBe('/status')
		expect(RUNNER_HEALTH_PATH).toBe('/health')
	})
})
