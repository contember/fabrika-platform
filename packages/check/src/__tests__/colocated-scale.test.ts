// 200 colocated endpoints in 10 group modules, each handler importing a module of its own, read the way Control reads
// a commit: no handler module is requested, the read stays within the reader's budget, and it equals the slice's own
// read of the same modules without their handlers.

import { canonicalArtifactJson } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { readContractSource } from '../contract'
import { CONTRACT_LIMITS } from '../limits'
import { fetchedByControl, KIT_ROOT, readTree } from './colocated-helpers'

const GROUPS = 10
const PER_GROUP = 20

/** One endpoint per access form: its declaration, and a handler that calls into its group's `logic.ts`. */
const FORMS: readonly { readonly declaration: string; readonly handler: string }[] = [
	{
		declaration: "r.query({ input: OrgInput, output: DealPage, access: { action: 'crm.read', over: 'org' } })",
		handler: 'async ({ ctx }) => page(await ctx.db.within.companies.list({ limit: 10 }))',
	},
	{
		declaration: "r.mutation({ input: NewCompany, output: Saved, access: { action: 'crm.write', in: 'org', from: 'orgId' } })",
		handler: '({ input, ctx }) => ctx.db.target.companies.insert({ name: named(input.name) })',
	},
	{
		declaration: "r.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } })",
		handler: 'async ({ ctx }) => view(await ctx.db.target.get())',
	},
	{
		declaration: "r.mutation({ input: ReopenDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } })",
		handler:
			"async ({ input, ctx }) => {\n\t\t\tconst deal = await ctx.db.target.getForUpdate()\n\t\t\tif (!reopens(deal.stage)) throw new ConflictError('only a won or lost deal reopens')\n\t\t\treturn ctx.db.target.update({ stage: 'proposal' }, { expectVersion: input.expectVersion })\n\t\t}",
	},
	{
		declaration: "r.query({ input: OrgInput, output: Pipeline, access: { action: 'crm.read', in: 'org', from: 'orgId' }, sql: 'read' })",
		handler:
			'async ({ ctx }) => ({ rows: await ctx.sql(PipelineRow)`select stage, count(*) as deals from deals where org_id = ${ctx.target.value} group by stage` })',
	},
]

/** A group module with each endpoint's handler beside it, or, as written without colocated handlers, without them. */
const groupModule = (group: number, handled: boolean): string => {
	const endpoints = Array.from({ length: PER_GROUP }, (_, index) => {
		const form = FORMS[index % FORMS.length]
		return form === undefined ? '' : `\te${index}: ${form.declaration}${handled ? `\n\t\t.handle(${form.handler})` : ''},`
	})
	const handlerImports = "import { ConflictError } from '@fabrika/app'\nimport { named, page, reopens, view } from './logic'\n"
	return `${handled ? handlerImports : ''}import { app } from '../app-kit'
import { ById, Deal, DealPage, NewCompany, OrgInput, Pipeline, PipelineRow, ReopenDeal, Saved } from '../schemas'

export const g${group} = app.group({ callers: ['human'] }, (r) => ({
${endpoints.join('\n')}
}))
`
}

/** The kit fixture's vocabulary, tables and schemas, with a contract that mounts the generated groups. */
const commit = (handled = true): Map<string, string> => {
	const files = readTree(KIT_ROOT)
	const names = Array.from({ length: GROUPS }, (_, group) => `g${group}`)
	for (const [group, name] of names.entries()) {
		files.set(`src/${name}/endpoints.ts`, groupModule(group, handled))
		files.set(`src/${name}/logic.ts`, "throw new Error('a handler module was read')\n")
	}
	files.set(
		'fabrika.contract.ts',
		`import { app } from './src/app-kit'
${names.map((name) => `import { ${name} } from './src/${name}/endpoints'`).join('\n')}

export const contract = app.contract((c) => ({ api: c.rpc('/api', { ${names.join(', ')} }) }))
`,
	)
	files.delete('src/app.ts')
	// No endpoint here connects, so the kit imports nothing.
	files.set(
		'src/app-kit.ts',
		"import { defineApp } from '@fabrika/app/contract'\nimport { tables } from './db/tables'\nimport { vocabulary } from './vocabulary'\n\nexport const app = defineApp(vocabulary, tables)\n",
	)
	return files
}

describe('the shell slice over 200 colocated endpoints', () => {
	test('Control requests no handler module, and the read is within the budget and fast', () => {
		const started = performance.now()
		const fetched = fetchedByControl(commit())
		const artifact = readContractSource(fetched)
		const seconds = (performance.now() - started) / 1000
		const bytes = [...fetched.values()].reduce((total, text) => total + new TextEncoder().encode(text).byteLength, 0)
		console.info(`the shell slice over 200 endpoints in ${GROUPS} groups: ${seconds.toFixed(2)} s, ${bytes} bytes fetched`)
		expect([...fetched.keys()].filter((path) => path.endsWith('/logic.ts'))).toEqual([])
		expect(artifact.endpoints.filter((row) => row.id.startsWith('api.g'))).toHaveLength(GROUPS * PER_GROUP)
		expect(bytes).toBeLessThan(CONTRACT_LIMITS.sourceBytes)
		expect(seconds).toBeLessThan(10)
	}, 60_000)

	test('the read equals the read of the same modules written without their handlers', () => {
		expect(canonicalArtifactJson(readContractSource(fetchedByControl(commit())))).toBe(canonicalArtifactJson(readContractSource(commit(false))))
	})
})
