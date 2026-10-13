// What a form inbox and a reference table take, in the checker: a form's input fields are the columns of its inbox,
// and no site declares an unscoped write of either table. `compileContract` refuses both against `src/db/tables.ts`,
// so `fabrika-check` reports them from source, before any test boots the application.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { checkApplication } from '../check'
import type { Finding } from '../finding'
import { KIT_ROOT, readTree } from './colocated-helpers'

const INTAKE_ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'fixtures', 'visitor-intake')

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

describe("a form's input fields are its inbox's columns", () => {
	test('a field named in camelCase over a snake_case column is reported, with the column it means', async () => {
		const findings = await contractFindings(
			INTAKE_ROOT,
			'src/schemas.ts',
			(text) =>
				text.replace('export const Resend = z.strictObject({ email: z.email().max(200) })', 'export const Resend = z.strictObject({ eMail: z.email() })'),
		)
		expect(findings).toEqual([
			refusal(
				"mount 'resend': the input field 'eMail' is not a column of its inbox resend_requests — did you mean 'email'? (allowed: a field named like a column: email)",
			),
		])
	})

	test('the honeypot and, with a challenge, the challenge token are no columns', async () => {
		const guarded = (options: string) => (text: string) =>
			text.replace(
				"register: c.form('/register', { input: Register, appendTo: 'registrations', maxBytes: 2048 }),",
				`register: c.form('/register', { input: Guarded, appendTo: 'registrations'${options} }),`,
			).replace(
				"import { Register, Resend } from './src/schemas'",
				"import { z } from 'zod/v4'\nimport { Resend } from './src/schemas'\n\nconst Guarded = z.strictObject({ email: z.email(), name: z.string(), website: z.optional(z.string()), challengeToken: z.string() })",
			)
		const declared = ", honeypot: 'website', challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' }"
		expect(await contractFindings(INTAKE_ROOT, 'fabrika.contract.ts', guarded(declared))).toEqual([])
		expect((await contractFindings(INTAKE_ROOT, 'fabrika.contract.ts', guarded(''))).map((finding) => finding.message)).toEqual([
			"mount 'register': the input field 'website' is not a column of its inbox registrations (allowed: a field named like a column: email, name)",
			"mount 'register': the input field 'challengeToken' is not a column of its inbox registrations (allowed: a field named like a column: email, name)",
		])
	})
})

describe('no site writes a reference table or a form inbox', () => {
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

	test("an unscoped: 'write' of a form inbox is reported", async () => {
		const findings = await contractFindings(
			INTAKE_ROOT,
			'src/intake/endpoints.ts',
			(text) => text.replace("\tsql: 'write',\n", "\tsql: 'write',\n\tunscoped: { registrations: 'write' },\n"),
		)
		expect(findings).toEqual([
			refusal("job 'intake': declares unscoped 'registrations': 'write', and only its form writes a form's inbox (allowed: 'read')"),
		])
	})
})
