// Handlers colocated with their endpoints, and the shell slice that keeps them from Control: a module only a handler
// imports is never requested, parsed or run by the reader, the static read equals `compileContract` of the evaluated
// modules, and a Bun build through `@fabrika/check/bun-plugin` holds no handler code.

import { compileContract } from '@fabrika/app/contract'
import { canonicalArtifactJson } from '@fabrika/auth-core'
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { contract as kitContract } from '../../../app/src/__tests__/kit-fixture/fabrika.contract'
import { tables as kitTables } from '../../../app/src/__tests__/kit-fixture/src/db/tables'
import { parseModule } from '../ast'
import { checkApplication } from '../check'
import { ContractSourceError, readContractSource } from '../contract'
import { shellSlice } from '../slice'
import {
	ARCHITECTURE_ROOT,
	buildWithPlugin,
	evaluateInBun,
	fetchedByControl,
	KIT_ROOT,
	materialize,
	readTree,
	removeMaterialized,
} from './colocated-helpers'

/** A module only handlers import, which leaves a mark and throws when it runs. */
const THROWING_LOGIC = `import { mkdirSync } from 'node:fs'

mkdirSync(new URL('./LOADED', import.meta.url).pathname, { recursive: true })
throw new Error('a handler module ran at import')

export const canReopen = (stage: string): boolean => stage === 'won' || stage === 'lost'
`

afterAll(removeMaterialized)

const kitTree = (): Map<string, string> => new Map([...readTree(KIT_ROOT), ['src/deals/logic.ts', THROWING_LOGIC]])

const evaluated = canonicalArtifactJson(compileContract(kitContract, kitTables))

/** The first refusals of a tree whose `path` holds `text`, as `file:line:col rule`. */
const refusals = (path: string, text: string): string[] => {
	try {
		readContractSource(new Map([...kitTree(), [path, text]]))
	} catch (error) {
		if (error instanceof ContractSourceError) {
			return error.findings.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule}`)
		}
		throw error
	}
	return []
}

const DEALS = readTree(KIT_ROOT).get('src/deals/endpoints.ts') ?? ''

describe('the reader never reaches a module only handlers import', () => {
	test('contractReaderInputs never requests it, and the read equals the evaluated modules', () => {
		const fetched = fetchedByControl(kitTree())
		expect(fetched.has('src/deals/endpoints.ts')).toBe(true)
		expect(fetched.has('src/deals/logic.ts')).toBe(false)
		expect(canonicalArtifactJson(readContractSource(fetched))).toBe(evaluated)
	})

	test('given among the files anyway, it is neither parsed nor read', () => {
		const unparsable = new Map([...kitTree(), ['src/deals/logic.ts', 'export const canReopen = ((( this is not TypeScript']])
		expect(canonicalArtifactJson(readContractSource(unparsable))).toBe(evaluated)
	})

	test('Bun runs it when it evaluates the modules; a build through the plugin does not, and compiles to the same artifact', async () => {
		const directory = materialize(kitTree())
		expect(evaluateInBun(join(directory, 'fabrika.contract.ts'), join(directory, 'src/db/tables.ts'))).toEqual({
			ok: false,
			error: 'Error: a handler module ran at import',
		})
		rmSync(join(directory, 'src/deals/LOADED'), { recursive: true })
		expect(buildWithPlugin(directory, 'fabrika.contract.ts', { target: 'bun', external: ['zod', '@fabrika/*'] })).toEqual({ ok: true, error: '' })
		const output = await Bun.file(join(directory, 'out', 'fabrika.contract.js')).text()
		for (const handlerCode of ['a handler module ran at import', 'canReopen', 'getForUpdate', 'ConflictError', 'ctx.sql']) {
			expect(output).not.toContain(handlerCode)
		}
		expect(evaluateInBun(join(directory, 'out', 'fabrika.contract.js'), join(directory, 'src/db/tables.ts'))).toEqual({ ok: true, json: evaluated })
		expect(existsSync(join(directory, 'src/deals/LOADED'))).toBe(false)
	})

	test('serve refuses the sliced contract, naming every site without a handler', async () => {
		const directory = materialize(readTree(KIT_ROOT))
		expect(buildWithPlugin(directory, 'fabrika.contract.ts', { target: 'bun', external: ['zod', '@fabrika/*'] })).toEqual({ ok: true, error: '' })
		const script = join(directory, 'serve-sliced.mjs')
		writeFileSync(
			script,
			`import { serve } from '@fabrika/app/implement'
const { contract } = await import(process.argv[2])
try { serve(contract, { database: null }); console.log('served') } catch (error) { console.log(error.problems.map((problem) => problem.split(':')[0]).join(' ')) }
`,
		)
		const run = Bun.spawnSync([process.execPath, script, join(directory, 'out', 'fabrika.contract.js')], { cwd: directory })
		expect(run.stdout.toString().trim().split(' ').sort()).toEqual([
			'api.companies.audit',
			'api.companies.countries',
			'api.companies.create',
			'api.companies.deal',
			'api.deals.get',
			'api.deals.list',
			'api.deals.pipeline',
			'api.deals.product',
			'api.deals.reopen',
			'api.deals.share',
			'exports.pipeline.deal',
			'github',
			'jobs.close',
			'shared.deal',
		])
	})

	test("an SPA build of an application's web entry through the plugin holds no handler code", async () => {
		const directory = materialize(readTree(ARCHITECTURE_ROOT, ['.fixture']))
		expect(buildWithPlugin(directory, 'web/main.ts')).toEqual({ ok: true, error: '' })
		const output = await Bun.file(join(directory, 'out', 'main.js')).text()
		expect(output).toContain('/api')
		for (const handlerCode of ['canReopen', 'lockedStage', 'companyOf', 'ConflictError', 'getForUpdate', 'select d.stage']) {
			expect(output).not.toContain(handlerCode)
		}
	})
})

/** Whether a browser build of `entry` under `root` through the plugin, every package bundled, succeeds. */
const builds = (root: string, entry: string): boolean => buildWithPlugin(root, entry).ok

const HANDLER_CODE = ['.handle(', 'getForUpdate', 'canReopen', 'ConflictError', 'a handler module ran at import']

describe('an SPA build through the plugin, with every package bundled', () => {
	test('bundles the shell of the kit fixture, and none of its handlers', async () => {
		const directory = materialize(kitTree())
		expect(builds(directory, 'fabrika.contract.ts')).toBe(true)
		const output = await Bun.file(join(directory, 'out', 'fabrika.contract.js')).text()
		expect(output).toContain('/healthz')
		for (const code of HANDLER_CODE) expect(output).not.toContain(code)
	})

	test('a JavaScript shell module is sliced like a TypeScript one', async () => {
		const tree = kitTree()
		const javascript = DEALS.replace(' as const', '')
		expect(javascript).not.toBe(DEALS)
		tree.delete('src/deals/endpoints.ts')
		tree.set('src/deals/endpoints.js', javascript)
		expect(canonicalArtifactJson(readContractSource(fetchedByControl(tree)))).toBe(evaluated)
		const directory = materialize(tree)
		expect(builds(directory, 'fabrika.contract.ts')).toBe(true)
		const output = await Bun.file(join(directory, 'out', 'fabrika.contract.js')).text()
		for (const code of HANDLER_CODE) expect(output).not.toContain(code)
	})

	for (
		const [form, call, module] of [
			['a named handler', '.handle(getDeal)', "import { getDeal } from './handlers'"],
			['a decorated handler', '.handle(traced(async () => ({ id: "", title: "", stage: "lead" })))', "import { traced } from './handlers'"],
			['a computed handle', "['handle'](getDeal)", "import { getDeal } from './handlers'"],
			['a non-null handle', '.handle!(getDeal)', "import { getDeal } from './handlers'"],
			['a handle cast to the handler type', '.handle<typeof getDeal>(getDeal as typeof getDeal)', "import { getDeal } from './handlers'"],
		] as const
	) {
		test(`${form} is refused before its module is requested, and the build fails`, async () => {
			const tree = kitTree()
			const endpoints = DEALS.replace("import { canReopen } from './logic'", `import { canReopen } from './logic'\n${module}`).replace(
				'\t\t.handle(async ({ ctx }) => {\n\t\t\tconst deal = await ctx.db.target.get()\n\t\t\treturn { id: deal.id, title: deal.title, stage: deal.stage }\n\t\t}),',
				`\t\t${call},`,
			)
			expect(endpoints).toContain(call)
			tree.set('src/deals/endpoints.ts', endpoints)
			tree.set('src/deals/handlers.ts', THROWING_LOGIC)
			expect(fetchedByControl(tree).has('src/deals/handlers.ts')).toBe(false)
			const line = endpoints.split('\n').findIndex((text) => text.includes(call)) + 1
			expect(refusals('src/deals/endpoints.ts', endpoints)).toEqual([`src/deals/endpoints.ts:${line}:4 literal`])
			expect(builds(materialize(tree), 'fabrika.contract.ts')).toBe(false)
		})
	}
})

describe('the slice removes only the handlers and what only they use, and keeps every position', () => {
	test('each .handle(…) and the imports only handlers use are blank, on the same lines and columns', () => {
		const slice = shellSlice('src/deals/endpoints.ts', DEALS).text
		expect(slice.length).toBe(DEALS.length)
		expect(slice.split('\n').length).toBe(DEALS.split('\n').length)
		for (const removed of ['.handle(', 'ConflictError', './logic', 'canReopen']) {
			expect(slice).not.toContain(removed)
		}
		expect(slice).toContain("import { app } from '../app-kit'")
		expect(slice).toContain("export const deals = app.group({ callers: ['human'] }, (r) => ({")
	})

	for (
		const call of [
			"r.query({})['handle'](getDeal)",
			'r.query({}).handle!(getDeal)',
			'(r.query({}) satisfies object).handle(getDeal)',
			'(r.query({}) as const).handle(getDeal)',
			'(r.query({})).handle(async () => getDeal())',
			'(r.query({}).handle)(getDeal)',
			'(r.query({}).handle as typeof getDeal)(async () => 1)',
			'(<typeof getDeal> r.query({}).handle)(async () => 1)',
		]
	) {
		test(`${call} is refused, and its slice parses without what it names`, () => {
			const text = `import { getDeal } from './handlers'\n\nexport const deal = (r: Builder) => ${call}\n`
			const slice = shellSlice('src/deal.ts', text)
			expect(slice.refusals).toHaveLength(1)
			expect(slice.text).not.toContain('getDeal')
			expect(slice.text.length).toBe(text.length)
			expect(parseModule('src/deal.ts', slice.text).ok).toBe(true)
		})
	}

	test('a handle refused on another handle is read for its own, and both are refused', () => {
		const text = "import { getDeal } from './handlers'\n\nexport const deal = (r: Builder) => wrap(r.query({}).handle(getDeal)).handle(async () => 1)\n"
		const slice = shellSlice('src/deal.ts', text)
		expect(slice.refusals).toHaveLength(2)
		expect(slice.text).not.toContain('getDeal')
		expect(parseModule('src/deal.ts', slice.text).ok).toBe(true)
	})

	test('a module without a handler is its own slice', () => {
		const schemas = readTree(KIT_ROOT).get('src/schemas.ts') ?? ''
		expect(shellSlice('src/schemas.ts', schemas)).toEqual({ text: schemas, refusals: [] })
	})

	test('a helper only a handler calls goes with it, its own imports included', () => {
		const helper = DEALS.replace(
			"import { canReopen } from './logic'",
			"import { canReopen } from './logic'\n\nconst reopens = (stage: string): boolean => canReopen(stage)",
		).replace('if (!canReopen(deal.stage))', 'if (!reopens(deal.stage))')
		expect(helper).not.toBe(DEALS)
		const slice = shellSlice('src/deals/endpoints.ts', helper).text
		expect(slice).not.toContain('reopens')
		expect(slice).not.toContain('./logic')
		expect(canonicalArtifactJson(readContractSource(new Map([...kitTree(), ['src/deals/endpoints.ts', helper]])))).toBe(evaluated)
	})
})

describe('what the slice keeps, the literal rule reads', () => {
	test('an import the shell also uses stays, and its module is then a shell module', () => {
		const shared = DEALS.replace("import { canReopen } from './logic'", "import { canReopen, STAGES } from './logic'").replace(
			"from: 'id' } })\n\t\t.handle(async ({ input, ctx }) => {\n\t\t\tconst deal = await ctx.db.target.getForUpdate()",
			"from: 'id' }, sql: STAGES })\n\t\t.handle(async ({ input, ctx }) => {\n\t\t\tconst deal = await ctx.db.target.getForUpdate()",
		)
		expect(shared).not.toBe(DEALS)
		const logic = `${THROWING_LOGIC}export const STAGES = 'read'\n`
		expect(shellSlice('src/deals/endpoints.ts', shared).text).toContain("import { STAGES } from './logic'")
		expect(
			refusalsWith(new Map([['src/deals/endpoints.ts', shared], ['src/deals/logic.ts', logic]])).some((finding) =>
				finding.startsWith('src/deals/logic.ts:')
			),
		)
			.toBe(true)
	})

	test('an import nobody uses is not a handler import: it stays, and the literal rule refuses a module that runs code', () => {
		const unused = DEALS.replace("import { canReopen } from './logic'", "import { canReopen } from './logic'\nimport { unused } from './unused'")
		expect(refusalsWith(new Map([['src/deals/endpoints.ts', unused], ['src/deals/unused.ts', 'export const unused = new Map()\n']]))).toContain(
			'src/deals/unused.ts:1:23 literal',
		)
	})

	test('.handle given a named function is refused at its handle', () => {
		const named = DEALS.replace(
			'\t\t.handle(async ({ ctx }) => {\n\t\t\tconst deal = await ctx.db.target.get()',
			'\t\t.handle(getDeal),\n\tnever: r.query({ output: Deal, access: { member: true } })\n\t\t.handle(async ({ ctx }) => {\n\t\t\tconst deal = await ctx.db.target.get()',
		)
		expect(named).not.toBe(DEALS)
		const line = named.split('\n').findIndex((text) => text.includes('.handle(getDeal)')) + 1
		expect(refusals('src/deals/endpoints.ts', named)).toEqual([`src/deals/endpoints.ts:${line}:4 literal`])
	})

	test('.handle on a builder that takes no handler is refused', () => {
		const contract = readTree(KIT_ROOT).get('fabrika.contract.ts') ?? ''
		const handled = contract.replace("health: c.health('/healthz'),", "health: c.health('/healthz').handle(() => null),")
		expect(handled).not.toBe(contract)
		expect(refusals('fabrika.contract.ts', handled)).not.toEqual([])
	})

	test('an exported helper is part of the module: it keeps the import it uses, which the literal rule refuses', () => {
		const exported = DEALS.replace("import { canReopen } from './logic'", "import { canReopen } from './logic'\n\nexport const reopens = canReopen")
		expect(refusals('src/deals/endpoints.ts', exported)).toContain('src/deals/endpoints.ts:4:10 literal')
	})

	test('a refusal after a handler keeps its line and column', () => {
		const late = DEALS.replace('}))\n', "\tbroken: r.query({ output: Deal, access: { member: true }, sql: `${'read'}` }),\n}))\n")
		expect(late).not.toBe(DEALS)
		const line = late.split('\n').findIndex((text) => text.includes('broken:')) + 1
		expect(refusals('src/deals/endpoints.ts', late)[0]).toBe(`src/deals/endpoints.ts:${line}:65 literal`)
	})

	test("defineTables from @fabrika/db's root is refused: the SPA bundles the shell graph, and that root loads Bun", () => {
		const tables = readTree(KIT_ROOT).get('src/db/tables.ts') ?? ''
		const root = tables.replace("from '@fabrika/db/tables'", "from '@fabrika/db'")
		expect(root).not.toBe(tables)
		expect(refusals('src/db/tables.ts', root)).toContain('src/db/tables.ts:1:10 literal')
	})

	test('groups of one mount that name different callers are refused at the mount', () => {
		const machine = DEALS.replace("app.group({ callers: ['human'] }", "app.group({ callers: ['machine'] }")
		const line = (readTree(KIT_ROOT).get('fabrika.contract.ts') ?? '').split('\n').findIndex((text) => text.includes('c.rpc(')) + 1
		expect(refusals('src/deals/endpoints.ts', machine)).toEqual([`fabrika.contract.ts:${line}:7 contract`])
	})
})

/** `refusals` over the kit tree with several files replaced. */
const refusalsWith = (replaced: ReadonlyMap<string, string>): string[] => {
	try {
		readContractSource(new Map([...kitTree(), ...replaced]))
	} catch (error) {
		if (error instanceof ContractSourceError) {
			return error.findings.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule}`)
		}
		throw error
	}
	return []
}

describe('the checker reads the shell slice too', () => {
	test("the architecture fixture's whole check is clean", async () => {
		expect(await checkApplication({ root: ARCHITECTURE_ROOT, files: readTree(ARCHITECTURE_ROOT, ['.fixture', '.sql']) })).toEqual([])
	})
})
