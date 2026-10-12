// A contract of many procedures, cycling through the access forms, compiled in memory with the package's options.
// The contract and implement scale tests share it; the instantiation count is their deterministic witness.

import { join } from 'node:path'
import ts from 'typescript'

const packageDir = join(import.meta.dir, '..', '..')
const virtualFile = join(import.meta.dir, 'scale.generated.ts')

/** One procedure per form, and the handler `implement` takes for it. */
const FORMS: readonly (readonly [procedure: string, handler: string])[] = [
	[
		"c.query({ output: z.array(z.strictObject({ id: z.uuid(), title: z.string() })), access: { action: 'notes.read', over: 'workspace' } })",
		"({ ctx }) => [{ id: ctx.within.dimension, title: 'x' }]",
	],
	[
		"c.mutation({ input: z.strictObject({ workspaceId: z.uuid(), title: z.string().min(1) }), output: z.strictObject({ id: z.uuid() }), access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })",
		'({ input, ctx }) => ({ id: `${ctx.target.value}${input.title}` })',
	],
	[
		"c.query({ input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ id: z.uuid(), title: z.string(), body: z.string().nullable() }), access: { action: 'notes.read', on: 'note', from: 'id' } })",
		"({ ctx }) => ({ id: ctx.target.value, title: 'x', body: null })",
	],
	[
		"c.mutation({ input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ deleted: z.uuid() }), access: { action: 'notes.delete', on: 'note', from: 'id' } })",
		'({ ctx }) => ({ deleted: ctx.target.value })',
	],
	['c.query({ output: z.strictObject({ email: z.email() }), access: { member: true } })', '({ ctx }) => ({ email: ctx.principal.label })'],
	[
		"c.mutation({ input: z.strictObject({ name: z.string() }), output: z.strictObject({ id: z.uuid() }), access: { action: 'workspaces.create', creates: 'workspace' } })",
		'({ ctx }) => ({ id: ctx.created.value })',
	],
]

function tree(procedures: number, pick: (form: readonly [string, string]) => string, indent: string): string {
	const groups: string[] = []
	for (let group = 0; group < procedures / 10; group++) {
		const members = Array.from({ length: 10 }, (_, index) => {
			const number = group * 10 + index
			const form = FORMS[number % FORMS.length] ?? FORMS[0] ?? ['', '']
			return `${indent}\t\tp${number}: ${pick(form)},`
		})
		groups.push(`${indent}\tg${group}: {\n${members.join('\n')}\n${indent}\t},`)
	}
	return groups.join('\n')
}

/** The contract module; with `implemented`, also `implement` with a handler for every procedure. */
export function scaleSource(procedures: number, implemented: boolean): string {
	const contract = `import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const contract = defineContract({
	app: 'scale',
	dimensions: { workspace: { creator: 'owner', members: { manage: 'notes.admin', list: 'notes.read' } }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'r', 'notes.write': 'w', 'notes.delete': 'd', 'notes.admin': 'a', 'workspaces.create': 'c' },
	roles: {
		starter: { grants: ['workspaces.create'] },
		owner: { grants: ['notes.read', 'notes.write', 'notes.delete', 'notes.admin'], member: { scope: 'workspace', assignableBy: ['owner'] } },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
${tree(procedures, ([procedure]) => procedure, '\t')}
	}),
}))
`
	if (!implemented) {
		return contract
	}
	return `${contract}
import { implement } from '../implement/implement'

export const app = implement(contract, {
	database: null,
	deps: () => null,
	handlers: () => ({
		api: {
${tree(procedures, ([, handler]) => handler, '\t\t')}
		},
	}),
})
`
}

export interface Compiled {
	readonly diagnostics: readonly string[]
	readonly seconds: number
	readonly instantiations: number
}

export function compileScale(source: string): Compiled {
	return compileScaleFiles(new Map([[virtualFile, source]]))
}

/** Compiles in-memory modules (absolute path → text), each a root, beside the package's real files. */
export function compileScaleFiles(sources: ReadonlyMap<string, string>): Compiled {
	const config = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile)
	const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir).options, noEmit: true }
	const host = ts.createCompilerHost(options)
	const readFile = host.readFile.bind(host)
	const fileExists = host.fileExists.bind(host)
	host.readFile = (file) => sources.get(file) ?? readFile(file)
	host.fileExists = (file) => sources.has(file) || fileExists(file)
	const getSourceFile = host.getSourceFile.bind(host)
	host.getSourceFile = (file, language, onError) => {
		const source = sources.get(file)
		return source === undefined ? getSourceFile(file, language, onError) : ts.createSourceFile(file, source, language)
	}

	const started = performance.now()
	const program = ts.createProgram([...sources.keys()], options, host)
	const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
		const where = diagnostic.file === undefined || diagnostic.start === undefined
			? ''
			: `${diagnostic.file.fileName}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1} `
		return `${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
	})
	return { diagnostics, seconds: (performance.now() - started) / 1000, instantiations: program.getInstantiationCount() }
}

/** One endpoint per form of the API matrix, with a handler that uses its `ctx.db`, on the kit fixture's CRM. */
const KIT_FORMS: readonly string[] = [
	"r.query({ input: OrgInput, output: CompanyPage, access: { action: 'crm.read', over: 'org' } }).handle(async ({ ctx }) => { const page = await ctx.db.within.companies.list({ limit: 10 }); return { items: page.items.map((company) => ({ id: company.id, name: company.name })), next: page.next } })",
	"r.mutation({ input: NewCompany, output: Saved, access: { action: 'crm.write', in: 'org', from: 'orgId' } }).handle(({ input, ctx }) => ctx.db.target.companies.insert({ name: input.name }))",
	"r.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } }).handle(async ({ ctx }) => { const deal = await ctx.db.target.get(); return { id: deal.id, title: deal.title, stage: deal.stage } })",
	"r.mutation({ input: ReopenDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } }).handle(async ({ input, ctx }) => { const deal = await ctx.db.target.getForUpdate(); return ctx.db.target.update({ stage: deal.stage }, { expectVersion: input.expectVersion }) })",
	'r.query({ output: Me, access: { member: true } }).handle(({ ctx }) => ({ label: ctx.principal.label }))',
	"r.query({ input: OrgInput, output: Pipeline, access: { action: 'crm.read', in: 'org', from: 'orgId' }, sql: 'read' }).handle(async ({ ctx }) => ({ rows: await ctx.sql(PipelineRow)`select stage, count(*) as deals from deals where org_id = ${ctx.target.value} group by stage` }))",
]

/**
 * The kit form of a contract of `procedures` endpoints: one module per group of `perGroup`, and the contract that
 * mounts them all under one RPC mount.
 */
export function kitScaleSources(procedures: number, perGroup: number): ReadonlyMap<string, string> {
	const sources = new Map<string, string>()
	const names: string[] = []
	for (let group = 0; group < procedures / perGroup; group++) {
		const endpoints = Array.from({ length: perGroup }, (_, index) => {
			const number = group * perGroup + index
			return `\tp${number}: ${KIT_FORMS[number % KIT_FORMS.length]},`
		})
		names.push(`g${group}`)
		sources.set(
			join(import.meta.dir, `kit-scale.g${group}.generated.ts`),
			`import { z } from 'zod/v4'
import { app } from './kit-fixture/src/app-kit'
import { ById, Company, Deal, NewCompany, OrgInput, Pipeline, PipelineRow, ReopenDeal, Saved } from './kit-fixture/src/schemas'

const CompanyPage = z.strictObject({ items: z.array(Company), next: z.nullable(z.string()) })
const Me = z.strictObject({ label: z.string() })

export const g${group} = app.group({ callers: ['human'] }, (r) => ({
${endpoints.join('\n')}
}))
`,
		)
	}
	sources.set(
		join(import.meta.dir, 'kit-scale.contract.generated.ts'),
		`import { app } from './kit-fixture/src/app-kit'
${names.map((name) => `import { ${name} } from './kit-scale.${name}.generated'`).join('\n')}

export const contract = app.contract((c) => ({ api: c.rpc('/api', { ${names.join(', ')} }) }))
`,
	)
	return sources
}
