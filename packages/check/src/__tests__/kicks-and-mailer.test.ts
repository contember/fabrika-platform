// A mutation's `kicks: ['<job>']` and a cron job's `mailer` in the static reader: Control reads both from source into
// the same artifact the evaluated modules compile to, and the reader refuses a kick of no job, or of a job that is not
// a cron job, as `compileContract` does.

import { compileContract } from '@fabrika/app/contract'
import { canonicalArtifactJson } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { app } from '../../../app/src/__tests__/kit-fixture/src/app-kit'
import { companies } from '../../../app/src/__tests__/kit-fixture/src/companies/endpoints'
import { tables } from '../../../app/src/__tests__/kit-fixture/src/db/tables'
import { deals } from '../../../app/src/__tests__/kit-fixture/src/deals/endpoints'
import { pipeline } from '../../../app/src/__tests__/kit-fixture/src/exports'
import { github } from '../../../app/src/__tests__/kit-fixture/src/hooks'
import { ById } from '../../../app/src/__tests__/kit-fixture/src/schemas'
import { shared } from '../../../app/src/__tests__/kit-fixture/src/shared'
import { readContractSource } from '../contract'
import { KIT_ROOT, readTree } from './colocated-helpers'

const JOBS = `import { app } from './app-kit'

export const close = app.cron('0 3 * * *', { actions: ['crm.read', 'deals.write'], mailer: 'installation' })
	.handle(async () => {})
`

const kicksSource = (kicked: string): string =>
	`import { app } from '../app-kit'
import { ById } from '../schemas'

export const kicks = app.group({ callers: ['human'] }, (r) => ({
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }, kicks: [${kicked}] })
		.handle(({ ctx }) => {
			ctx.kick('close')
			return { id: ctx.target.value }
		}),
}))
`

const CONTRACT = `import { app } from './src/app-kit'
import { companies } from './src/companies/endpoints'
import { deals } from './src/deals/endpoints'
import { pipeline } from './src/exports'
import { github } from './src/hooks'
import { close } from './src/jobs'
import { kicks } from './src/kicks/endpoints'
import { shared } from './src/shared'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { deals, companies, kicks }),
	shared,
	github,
	health: c.health('/healthz'),
	jobs: { close },
	exports: { pipeline },
}))
`

const source = (kicked: string): Map<string, string> =>
	new Map([
		...readTree(KIT_ROOT),
		['fabrika.contract.ts', CONTRACT],
		['src/jobs.ts', JOBS],
		['src/kicks/endpoints.ts', kicksSource(kicked)],
	])

const close = app.cron('0 3 * * *', { actions: ['crm.read', 'deals.write'], mailer: 'installation' }).handle(async () => {})

const kicks = app.group({ callers: ['human'] }, (r) => ({
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }, kicks: ['close'] })
		.handle(({ ctx }) => {
			ctx.kick('close')
			return { id: ctx.target.value }
		}),
}))

const evaluated = app.contract((c) => ({
	api: c.rpc('/api', { deals, companies, kicks }),
	shared,
	github,
	health: c.health('/healthz'),
	jobs: { close },
	exports: { pipeline },
}))

describe("a mutation's kicks and a job's mailer in the static reader", () => {
	test('read into the same artifact as the evaluated contract, each under its site', () => {
		const read = readContractSource(source("'close'"))
		const compiled = compileContract(evaluated, tables)
		expect(read.declared?.['api.kicks.touch']).toEqual({ sql: null, unscoped: {}, connect: [], issues: null, kicks: ['close'] })
		expect(read.declared?.['job:close']).toEqual({ sql: null, unscoped: {}, connect: [], issues: null, mailer: 'installation' })
		expect(read.declared).toEqual(compiled.declared)
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compiled))
	})

	test('refuses a kick of a job the contract does not declare', () => {
		expect(() => readContractSource(source("'clsoe'"))).toThrow(
			"procedure 'api.kicks.touch': kicks 'clsoe' is not a job of the contract (jobs: close) — did you mean 'close'?",
		)
	})

	test('refuses a job that is not a cron job, where the jobs section names it', () => {
		const files = new Map([[
			'fabrika.contract.ts',
			`import { defineContract } from '@fabrika/app/contract'

export const contract = defineContract({
	app: 'intake',
	dimensions: {},
	actions: { 'intake.read': 'Read registrations' },
	roles: { hr: { grants: ['intake.read'] } },
}, (c) => ({
	jobs: { welcome: c.health('/healthz') },
}))
`,
		]])
		expect(() => readContractSource(files)).toThrow(
			"fabrika.contract.ts:9:19 contract a c.health(…) where a builder call stands (allowed form: c.cron('<schedule>', { … }))",
		)
	})
})
