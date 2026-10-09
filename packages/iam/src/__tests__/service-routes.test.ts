// IAM's service contract names the live transport paths, and a composition serves exactly the rows its switches
// enable: a switched-off transport has no row, so IAM answers 404 there as its handlers did.

import { describe, expect, test } from 'bun:test'
import { iamServiceOptions } from '../app'
import { MINT_DELEGATION_PATH, MINT_EXCHANGE_PATH, MINT_KEY_PATH, MINT_SESSION_PATH } from '../rpc-http'
import { iamServiceContract } from '../service'

describe("IAM's service contract", () => {
	test('names the mint paths the router serves', () => {
		const live = [MINT_SESSION_PATH, MINT_KEY_PATH, MINT_EXCHANGE_PATH, MINT_DELEGATION_PATH]
		const contract = iamServiceContract({ health: false, managementRpc: false, mintRpc: true, membershipTransport: false })
		expect(contract.endpoints.filter((row) => row.id.startsWith('mint-')).map((row) => row.path)).toEqual(live)
	})

	test('a transport whose key is empty or blank is switched off, as its handler treated it', () => {
		expect(iamServiceOptions({})).toEqual({ health: false, managementRpc: false, mintRpc: false, membershipTransport: false })
		expect(iamServiceOptions({ rpcKey: ' ', proxyKey: '' })).toEqual({
			health: false,
			managementRpc: false,
			mintRpc: false,
			membershipTransport: false,
		})
		expect(iamServiceOptions({ rpcKey: 'r', proxyKey: 'p', health: true, membershipTransport: true })).toEqual({
			health: true,
			managementRpc: true,
			mintRpc: true,
			membershipTransport: true,
		})
	})
})
