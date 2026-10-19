// A reference table in the checker: no site declares an unscoped write of it. `compileContract` refuses one against
// `src/db/tables.ts`, so `fabrika-check` reports it from source, before any test boots the application.

import { describe, expect, test } from 'bun:test'
import { checkApplication } from '../check'
import type { Finding } from '../finding'
import { KIT_ROOT, readTree } from './colocated-helpers'

/** The `contract` findings of the application whose `path` is replaced by `edit` of it. */
const contractFindings = async (root: string, path: string, edit: (text: string) => string): Promise<Finding[]> => {
	const files = readTree(root)
	const text = files.get(path)
	if (text === undefined) throw new Error(`the fixture has no ${path}`)
	const edited = edit(text)
	if (edited === text) throw new Error(`the edit of ${path} changed nothing`)
	files.set(path, edited)
	const findings = await checkApplication({ root: '/application', files })
	return findings.filter((finding) => finding.rule === 'contract')
}

const refusal = (message: string): Finding => ({
	file: 'fabrika.contract.ts',
	line: 1,
	column: 1,
	severity: 'refusal',
	rule: 'contract',
	message,
	allowed: 'a contract that compiles against src/db/tables.ts',
})

describe('no site writes a reference table', () => {
	test("an unscoped: 'write' of a reference table is reported", async () => {
		const findings = await contractFindings(
			KIT_ROOT,
			'src/companies/endpoints.ts',
			(text) =>
				text.replace(
					"access: { action: 'crm.write', in: 'org', from: 'orgId' } })",
					"access: { action: 'crm.write', in: 'org', from: 'orgId' }, unscoped: { countries: 'write' } })",
				),
		)
		expect(findings).toEqual([
			refusal(
				"procedure 'api.companies.create': declares unscoped 'countries': 'write', and no site writes a reference table: its rows come from a migration (allowed: 'read')",
			),
		])
	})
})
