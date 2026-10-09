// The routes `createIamApp` serves are the ones B10's parity and route-coverage tests froze
// (`platform-artifacts/src/__tests__/service-parity/frozen.ts`), and the service contract names the live mint paths.
// The route comparison is deleted with `createIamApp` in B10d.

import type { Route } from '@fabrika/app'
import { describe, expect, test } from 'bun:test'
import { FROZEN_IAM_MINT_PATHS, frozenIamRoutes } from '../../../platform-artifacts/src/__tests__/service-parity/frozen'
import { type IamAppContext, iamRoutes } from '../app'
import { MINT_DELEGATION_PATH, MINT_EXCHANGE_PATH, MINT_KEY_PATH, MINT_SESSION_PATH } from '../rpc-http'
import { iamServiceContract } from '../service'

const asData = (routes: readonly Route<IamAppContext>[]) =>
	routes.map((entry) => ({ method: entry.kind === 'rpc' ? 'rpc' : entry.method, pattern: entry.pattern }))

describe('the frozen IAM routes are the live ones', () => {
	test('iamRoutes with and without liveness and the membership transport, in order', () => {
		expect(asData(iamRoutes({ health: true, membershipTransport: true }))).toEqual([...frozenIamRoutes(true, true)])
		expect(asData(iamRoutes({}))).toEqual([...frozenIamRoutes(false, false)])
	})

	test('the mint paths, as the router serves them and as the service contract names them', () => {
		const live = [MINT_SESSION_PATH, MINT_KEY_PATH, MINT_EXCHANGE_PATH, MINT_DELEGATION_PATH]
		expect([...FROZEN_IAM_MINT_PATHS]).toEqual(live)
		const contract = iamServiceContract({ health: false, managementRpc: false, mintRpc: true, membershipTransport: false })
		expect(contract.endpoints.filter((row) => row.id.startsWith('mint-')).map((row) => row.path)).toEqual(live)
	})
})
