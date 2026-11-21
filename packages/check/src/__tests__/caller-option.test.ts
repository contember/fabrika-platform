// `caller` of `defineApp`'s options and a procedure's `caller: false` in the static reader: both are the runtime's alone
// (`ctx.caller`), so Control reads them from source without a refusal into the artifact the evaluated modules compile
// to, and that artifact is the one the same contract without them compiles to.

import { canonicalArtifactJson } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { readContractSource } from '../contract'
import { KIT_ROOT, readTree } from './colocated-helpers'

const appKit = (caller: string): string =>
	`import { defineApp } from '@fabrika/app/contract'
import { catalogProductsV1 } from '../fabrika/connect/catalog.products.v1'
import { tables } from './db/tables'
import { vocabulary } from './vocabulary'

export const app = defineApp(vocabulary, tables, {
	imports: { catalog: { snapshot: catalogProductsV1, procedures: ['get'], timeoutMs: 400 } },${caller}
})
`

const CALLER = `
	caller: {
		table: 'orgs',
		principal: 'created_by',
		missing: 'No organisation belongs to this account.',
		refuse: [{ column: 'name', equals: 'archived', message: 'The organisation is archived.' }],
	},`

const meSource = (optOut: string): string =>
	`import { app } from '../app-kit'
import { ById } from '../schemas'

export const me = app.group({ callers: ['human'] }, (r) => ({
	read: r.query({ input: ById, output: ById, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(({ ctx }) => ({ id: ctx.target.value })),
	bind: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }${optOut} })
		.handle(({ ctx }) => ({ id: ctx.target.value })),
}))
`

const CONTRACT = `import { app } from './src/app-kit'
import { companies } from './src/companies/endpoints'
import { deals } from './src/deals/endpoints'
import { pipeline } from './src/exports'
import { github, ledger, ledgers } from './src/hooks'
import { close } from './src/jobs'
import { me } from './src/me/endpoints'
import { shared } from './src/shared'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { deals, companies, ledgers, me }),
	shared,
	github,
	ledger,
	health: c.health('/healthz'),
	jobs: { close },
	exports: { pipeline },
}))
`

const source = (caller: string, optOut: string): Map<string, string> =>
	new Map([
		...readTree(KIT_ROOT),
		['src/app-kit.ts', appKit(caller)],
		['fabrika.contract.ts', CONTRACT],
		['src/me/endpoints.ts', meSource(optOut)],
	])

describe("defineApp's caller in the static reader", () => {
	test('is read without a refusal and adds nothing to the artifact, nor does caller: false', () => {
		const declared = readContractSource(source(CALLER, ', caller: false'))
		const plain = readContractSource(source('', ''))
		expect(canonicalArtifactJson(declared)).toBe(canonicalArtifactJson(plain))
	})

	test('still refuses a caller that is not a literal', () => {
		expect(() => readContractSource(source('\n\tcaller: { table: String(1), principal: "created_by", missing: "x" },', ''))).toThrow(/literal/)
	})
})
