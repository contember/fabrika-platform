// The frozen gates still equal the live ones. Each export's test goes with it when B10c–e delete it (Operations' went
// with B10c, IAM's with B10d); the routes are compared in each service's own `service-routes.test.ts`, which can load
// its runtime.

import { CONTROL_PROXY_GATES, controlProxyGates } from '@fabrika/control/gates'
import { describe, expect, test } from 'bun:test'
import { frozenControlGates } from './frozen'

describe('the frozen gates are the live gates', () => {
	test('Control, with and without the MCP oauth rule', () => {
		expect(frozenControlGates()).toEqual(CONTROL_PROXY_GATES)
		expect(frozenControlGates()).toEqual(controlProxyGates())
		expect(frozenControlGates('https://console.example.com')).toEqual(controlProxyGates('https://console.example.com'))
	})
})
