// The routes `operationsApp` serves are the ones B10's parity and route-coverage tests froze
// (`platform-artifacts/src/__tests__/service-parity/frozen.ts`). Deleted with `operationsApp` in B10c.

import { describe, expect, test } from 'bun:test'
import { FROZEN_OPERATIONS_ROUTES } from '../../../platform-artifacts/src/__tests__/service-parity/frozen'
import { operationsRoutes } from '../app'

describe('the frozen Operations routes are the live ones', () => {
	test('operationsRoutes, in order', () => {
		const live = operationsRoutes.map((entry) => ({ method: entry.kind === 'rpc' ? 'rpc' : entry.method, pattern: entry.pattern }))
		expect(live).toEqual([...FROZEN_OPERATIONS_ROUTES])
	})
})
