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
import { implement } from '@fabrika/app/implement'

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
	const config = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile)
	const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir).options, noEmit: true }
	const host = ts.createCompilerHost(options)
	const readFile = host.readFile.bind(host)
	const fileExists = host.fileExists.bind(host)
	host.readFile = (file) => (file === virtualFile ? source : readFile(file))
	host.fileExists = (file) => file === virtualFile || fileExists(file)
	const getSourceFile = host.getSourceFile.bind(host)
	host.getSourceFile = (file, language, onError) =>
		file === virtualFile ? ts.createSourceFile(file, source, language) : getSourceFile(file, language, onError)

	const started = performance.now()
	const program = ts.createProgram([virtualFile], options, host)
	const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
	return { diagnostics, seconds: (performance.now() - started) / 1000, instantiations: program.getInstantiationCount() }
}
