// A form's `then` in the static reader: it reads it into the artifact the runtime compiles, and refuses a form that
// names no job of the contract or a job that is not a cron job, as `compileContract` does.

import { compileContract, defineContract } from '@fabrika/app/contract'
import { canonicalArtifactJson, type TablePolicyArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { readContractSource } from '../contract'

const INBOX: TablePolicyArtifact = {
	scope: { mode: 'inbox', form: 'apply' },
	actions: { read: 'intake.read', insert: null, update: null, delete: null },
	insert: [],
	update: [],
	version: null,
	createdBy: null,
	columns: {},
}
const TABLES = { applications: INBOX }

const VOCABULARY = {
	app: 'intake',
	dimensions: {},
	actions: { 'intake.read': 'Read registrations' },
	roles: { hr: { grants: ['intake.read'] } },
} as const

const source = (then: string, jobs = "welcome: c.cron('* * * * *', { actions: ['intake.read'], scope: 'app' })"): Map<string, string> =>
	new Map([[
		'fabrika.contract.ts',
		`import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const contract = defineContract({
	app: 'intake',
	dimensions: {},
	actions: { 'intake.read': 'Read registrations' },
	roles: { hr: { grants: ['intake.read'] } },
}, (c) => ({
	apply: c.form('/apply', { input: z.strictObject({ name: z.string() }), appendTo: 'applications', then: ${then} }),
	jobs: { ${jobs} },
}))
`,
	]])

const evaluated = defineContract(VOCABULARY, (c) => ({
	apply: c.form('/apply', { input: z.strictObject({ name: z.string() }), appendTo: 'applications', then: 'welcome' }),
	jobs: { welcome: c.cron('* * * * *', { actions: ['intake.read'], scope: 'app' }) },
}))

describe("a form's then in the static reader", () => {
	test('reads the job into the artifact the runtime compiles', () => {
		const read = readContractSource(source("'welcome'"), TABLES)
		expect(read.mounts['apply']).toMatchObject({ kind: 'form', then: 'welcome' })
		expect(read).toEqual(compileContract(evaluated, TABLES))
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compileContract(evaluated, TABLES)))
	})

	test('refuses a job the contract does not declare, and a then that is not text', () => {
		expect(() => readContractSource(source("'welcom'"), TABLES)).toThrow(
			"mount 'apply': then 'welcom' is not a job of the contract (jobs: welcome) — did you mean 'welcome'?",
		)
		expect(() => readContractSource(source('42'), TABLES)).toThrow('then is a number')
	})

	test('refuses a job that is not a cron job, where the jobs section names it', () => {
		expect(() => readContractSource(source("'welcome'", "welcome: c.health('/healthz')"), TABLES)).toThrow(
			"fabrika.contract.ts:11:19 contract a c.health(…) where a builder call stands (allowed form: c.cron('<schedule>', { … }))",
		)
	})
})
