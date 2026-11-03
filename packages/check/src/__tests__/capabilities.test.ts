// Several capabilities in the static reader: it reads `access: { capabilities }` of `@fabrika/app`'s members fixture
// into the requirement `buildArtifact` compiles, refuses a capability of a form it does not take, and the scaffold
// writes one denied case per capability, but none for an `over` one whose action another one needs in a related
// dimension, and says so for each.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ContractSourceError, readContractSource } from '../contract'
import { ENDPOINT_ACCESS_TEST, generatedTests, scaffoldInputs } from '../scaffold'
import { readTree } from './colocated-helpers'

const ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'members-fixture')
const ENDPOINTS = 'src/deals/endpoints.ts'
const OWNER_ACCESS = "access: { action: 'crm.read', on: 'deal', from: 'id' } })\n\t\t.handle(async ({ ctx }) => fromRow(Owner"

const withOwnerAccess = (access: string): Map<string, string> => {
	const files = readTree(ROOT)
	const source = files.get(ENDPOINTS) ?? ''
	expect(source).toContain(OWNER_ACCESS)
	files.set(ENDPOINTS, source.replace(OWNER_ACCESS, OWNER_ACCESS.replace("access: { action: 'crm.read', on: 'deal', from: 'id' }", access)))
	return files
}

const SEVERAL = "access: { capabilities: { deal: { action: 'crm.read', on: 'deal', from: 'id' }, orgs: { action: 'deals.write', over: 'org' } } }"

describe('several capabilities in the static reader', () => {
	test('reads each capability by its name into the requirement', () => {
		const read = readContractSource(withOwnerAccess(SEVERAL))
		expect(read.endpoints.find((row) => row.id === 'api.deals.owner')?.requirement).toEqual({
			kind: 'capabilities',
			capabilities: {
				deal: { action: 'crm.read', access: { form: 'on', dimension: 'deal', from: 'id' } },
				orgs: { action: 'deals.write', access: { form: 'over', dimension: 'org' } },
			},
		})
	})

	test('refuses a capability of the app form', () => {
		const files = withOwnerAccess(
			"access: { capabilities: { deal: { action: 'crm.read', on: 'deal', from: 'id' }, all: { action: 'crm.read', app: true } } }",
		)
		try {
			readContractSource(files)
			throw new Error('the contract was read')
		} catch (error) {
			if (!(error instanceof ContractSourceError)) throw error
			expect(error.findings.map((finding) => finding.message)).toEqual(["capability 'all' is not one capability"])
		}
	})

	test('the scaffold writes one denied case per capability', async () => {
		const inputs = scaffoldInputs(withOwnerAccess(SEVERAL))
		const tests = await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures)
		const endpoints = tests.get(ENDPOINT_ACCESS_TEST)
		expect(endpoints?.cases).toContain('api.deals.owner: the deal of another scope as capability deal is 404')
		expect(endpoints?.cases).toContain('api.deals.owner: a caller without deals.write (capability orgs) is 403')
		expect(endpoints?.text).toContain("await kit.capability('api.deals.owner', 'orgs', ")
	})

	test('the scaffold writes no case for an over capability whose action another one needs in a related dimension, and says so', async () => {
		const shared = "access: { capabilities: { deal: { action: 'crm.read', on: 'deal', from: 'id' }, orgs: { action: 'crm.read', over: 'org' } } }"
		const inputs = scaffoldInputs(withOwnerAccess(shared))
		const tests = await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures)
		const endpoints = tests.get(ENDPOINT_ACCESS_TEST)
		const note =
			'api.deals.owner: capability orgs has no denied case: deal needs crm.read in a related dimension, so every caller that passes it is answered the list'
		expect(endpoints?.cases).toContain('api.deals.owner: the deal of another scope as capability deal is 404')
		expect(endpoints?.cases).not.toContain('api.deals.owner: a caller without crm.read (capability orgs) is 403')
		expect(endpoints?.text).not.toContain("await kit.capability('api.deals.owner', 'orgs', ")
		expect(endpoints?.notes).toEqual([note])
		expect(endpoints?.text).toContain(`// Not checked: ${note}.`)
	})

	test('every ruled-out capability gets its note, also where the endpoint is left with no case', async () => {
		const overs = "access: { capabilities: { orgs: { action: 'crm.read', over: 'org' }, deals: { action: 'crm.read', over: 'deal' } } }"
		const inputs = scaffoldInputs(withOwnerAccess(overs))
		const endpoints = (await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures)).get(ENDPOINT_ACCESS_TEST)
		expect(endpoints?.cases.filter((name) => name.includes('capability'))).toEqual([])
		expect(endpoints?.notes).toEqual([
			'api.deals.owner: capability orgs has no denied case: deals needs crm.read in a related dimension, so every caller that passes it is answered the list',
			'api.deals.owner: capability deals has no denied case: orgs needs crm.read in a related dimension, so every caller that passes it is answered the list',
		])
		const several = scaffoldInputs(withOwnerAccess(SEVERAL))
		expect((await generatedTests(several.policies, several.artifact, several.fixtures)).get(ENDPOINT_ACCESS_TEST)?.notes).toEqual([])
	})
})
