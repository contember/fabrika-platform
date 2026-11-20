// Several capabilities in the static reader: it reads `access: { capabilities }` of `@fabrika/app`'s members fixture
// into the requirement `buildArtifact` compiles, and refuses a capability of a form it does not take.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { ContractSourceError, readContractSource } from '../contract'
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
})
