// A cron job's `issues: '<link mount>'` (WU15) in the static reader: Control reads the job's declared link mount from
// source into the same artifact the evaluated modules compile to.

import { compileContract } from '@fabrika/app/contract'
import { canonicalArtifactJson } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { app } from '../../../app/src/__tests__/kit-fixture/src/app-kit'
import { companies } from '../../../app/src/__tests__/kit-fixture/src/companies/endpoints'
import { tables } from '../../../app/src/__tests__/kit-fixture/src/db/tables'
import { deals } from '../../../app/src/__tests__/kit-fixture/src/deals/endpoints'
import { pipeline } from '../../../app/src/__tests__/kit-fixture/src/exports'
import { github } from '../../../app/src/__tests__/kit-fixture/src/hooks'
import { shared } from '../../../app/src/__tests__/kit-fixture/src/shared'
import { readContractSource } from '../contract'
import { KIT_ROOT, readTree } from './colocated-helpers'

const JOBS = `import { app } from './app-kit'

export const close = app.cron('* * * * *', { actions: ['crm.read', 'deals.share'], scope: 'app', issues: 'shared' })
	.handle(async ({ ctx }) => {
		await ctx.links.issue(await ctx.ref('deals.share', 'deal', 'id'), { mount: 'shared', days: 3 })
	})
`

const close = app.cron('* * * * *', { actions: ['crm.read', 'deals.share'], scope: 'app', issues: 'shared' }).handle(async () => {})

const evaluated = app.contract((c) => ({
	api: c.rpc('/api', { deals, companies }),
	shared,
	github,
	health: c.health('/healthz'),
	jobs: { close },
	exports: { pipeline },
}))

describe("a job's issues in the static reader", () => {
	test('reads into the same artifact as the evaluated contract, under the job', () => {
		const read = readContractSource(new Map([...readTree(KIT_ROOT), ['src/jobs.ts', JOBS]]))
		expect(read.declared?.['job:close']).toEqual({ sql: null, unscoped: {}, connect: [], issues: 'shared' })
		expect(canonicalArtifactJson(read)).toBe(canonicalArtifactJson(compileContract(evaluated, tables)))
	})
})
