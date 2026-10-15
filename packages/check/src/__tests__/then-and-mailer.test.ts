// A mutation's `then: '<job>'` and a cron job's `mailer` in the static reader: Control reads both from source into the
// same artifact the evaluated modules compile to, and the reader refuses a `then` that names no job, as
// `compileContract` does.

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

export const close = app.cron('0 3 * * *', { actions: ['crm.read', 'deals.write'], scope: 'app', mailer: 'installation' })
	.handle(async () => {})
`

const kicksSource = (then: string): string =>
	`import { app } from '../app-kit'
import { ById } from '../schemas'

export const kicks = app.group({ callers: ['human'] }, (r) => ({
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }, then: ${then} })
		.handle(({ ctx }) => ({ id: ctx.target.value })),
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

const source = (then: string): Map<string, string> =>
	new Map([
		...readTree(KIT_ROOT),
		['fabrika.contract.ts', CONTRACT],
		['src/jobs.ts', JOBS],
		['src/kicks/endpoints.ts', kicksSource(then)],
	])

const close = app.cron('0 3 * * *', { actions: ['crm.read', 'deals.write'], scope: 'app', mailer: 'installation' }).handle(async () => {})

const kicks = app.group({ callers: ['human'] }, (r) => ({
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }, then: 'close' })
		.handle(({ ctx }) => ({ id: ctx.target.value })),
}))

const evaluated = app.contract((c) => ({
	api: c.rpc('/api', { deals, companies, kicks }),
	shared,
	github,
	health: c.health('/healthz'),
	jobs: { close },
	exports: { pipeline },
}))

describe("a mutation's then and a job's mailer in the static reader", () => {
	test('read into the same artifact as the evaluated contract, each under its site', () => {
		const read = readContractSource(source("'close'"))
		const compiled = compileContract(evaluated, tables)
		expect(read.declared?.['api.kicks.touch']).toEqual({ sql: null, unscoped: {}, connect: [], issues: null, then: 'close' })
		expect(read.declared?.['job:close']).toEqual({ sql: null, unscoped: {}, connect: [], issues: null, mailer: 'installation' })
		expect(read.declared).toEqual(compiled.declared)
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compiled))
	})

	test('refuses a then that names no job of the contract', () => {
		expect(() => readContractSource(source("'clsoe'"))).toThrow(
			"procedure 'api.kicks.touch': then 'clsoe' is not a job of the contract (jobs: close) — did you mean 'close'?",
		)
	})
})
