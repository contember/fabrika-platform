// The frozen gates still equal the live ones. Each export's test goes with it when B10c–e delete it (Operations' went
// with B10c); the routes are compared in each service's own `service-routes.test.ts`, which can load its runtime.

import { CONTROL_PROXY_GATES, controlProxyGates } from '@fabrika/control/gates'
import { describe, expect, test } from 'bun:test'
import { PLATFORM_IAM_APP_ID, PLATFORM_PROXY_APPS } from '../../proxy-manifest'
import { FROZEN_IAM_GATES, frozenControlGates } from './frozen'

describe('the frozen gates are the live gates', () => {
	test('Control, with and without the MCP oauth rule', () => {
		expect(frozenControlGates()).toEqual(CONTROL_PROXY_GATES)
		expect(frozenControlGates()).toEqual(controlProxyGates())
		expect(frozenControlGates('https://console.example.com')).toEqual(controlProxyGates('https://console.example.com'))
	})

	test('IAM, as the platform proxy fronts it', () => {
		expect(PLATFORM_PROXY_APPS.find((app) => app.id === PLATFORM_IAM_APP_ID)?.gates).toEqual(FROZEN_IAM_GATES)
	})
})
