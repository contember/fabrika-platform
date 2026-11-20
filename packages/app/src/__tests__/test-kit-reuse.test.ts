// The test kit hashes the contract it compiled natively, to the digest the platform computes.

import { contractDigest } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { compileContract } from '../contract/compile'
import { kitContractDigest } from '../testing/kit'
import { contract } from './cloudflare-fixture/fabrika.contract'
import { tables } from './cloudflare-fixture/src/db/tables'

describe('the test kit of a contract this process compiled', () => {
	test("the kit's digest is the contract digest, taken natively", () => {
		const artifact = compileContract(contract, tables)
		expect(kitContractDigest(artifact)).toBe(contractDigest(artifact))
	})
})
