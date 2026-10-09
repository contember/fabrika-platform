// The routes and pre-route surfaces `controlApp` serves are the ones B10's parity and route-coverage tests froze
// (`platform-artifacts/src/__tests__/service-parity/frozen.ts`). Deleted with `controlApp` in B10e.

import type { Route } from '@fabrika/app'
import { describe, expect, test } from 'bun:test'
import {
	FROZEN_CONTROL_BUILDER_PATHS,
	FROZEN_CONTROL_MCP,
	FROZEN_CONTROL_ROUTES,
} from '../../../platform-artifacts/src/__tests__/service-parity/frozen'
import { CONTROL_MCP_PATH } from '../../fabrika.service'
import { type ControlAppContext, controlRoutes } from '../app'
import { builderPublicResponse } from '../builder-bootstrap'
import { isMcpRequest } from '../zerops/mcp'

const asData = (routes: readonly Route<ControlAppContext>[]) =>
	routes.map((entry) => ({ method: entry.kind === 'rpc' ? 'rpc' : entry.method, pattern: entry.pattern }))

describe('the frozen Control routes are the live ones', () => {
	test('controlRoutes, in order', () => {
		expect(asData(controlRoutes)).toEqual([...FROZEN_CONTROL_ROUTES])
	})

	test('the builder bootstrap answers exactly the frozen paths, for every method', () => {
		for (const method of ['GET', 'POST', 'DELETE']) {
			for (const path of FROZEN_CONTROL_BUILDER_PATHS) {
				expect(builderPublicResponse(new Request(`https://console.test${path}`, { method }), {}, 'zerops')).not.toBeNull()
			}
			for (const path of ['/', '/builder/connect/', '/.well-known/fabrika-builder/x']) {
				expect(builderPublicResponse(new Request(`https://console.test${path}`, { method }), {}, 'zerops')).toBeNull()
			}
		}
	})

	test('withMcp takes the frozen methods on /mcp, after dropping empty segments', () => {
		expect(FROZEN_CONTROL_MCP.path).toBe(CONTROL_MCP_PATH)
		for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
			for (const path of ['/mcp', '/mcp/']) {
				expect(isMcpRequest(new Request(`https://console.test${path}`, { method }))).toBe(FROZEN_CONTROL_MCP.methods.includes(method))
			}
			expect(isMcpRequest(new Request(`https://console.test/mcp/x`, { method }))).toBe(false)
		}
	})
})
