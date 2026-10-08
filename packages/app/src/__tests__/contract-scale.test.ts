// A contract of 200 procedures, cycling through the access forms, type-checks fast enough to author. The test
// compiles it in memory with the package's options. The instantiation count is the deterministic witness; the time
// is printed, and the bound only catches a pathological regression on a loaded machine.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import ts from 'typescript'

const PROCEDURES = 200
const packageDir = join(import.meta.dir, '..', '..')
const virtualFile = join(import.meta.dir, 'contract-scale.generated.ts')

const FORMS = [
	"c.query({ output: z.array(z.strictObject({ id: z.uuid(), title: z.string() })), access: { action: 'notes.read', over: 'workspace' } })",
	"c.mutation({ input: z.strictObject({ workspaceId: z.uuid(), title: z.string().min(1) }), output: z.strictObject({ id: z.uuid() }), access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } })",
	"c.query({ input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ id: z.uuid(), title: z.string(), body: z.string().nullable() }), access: { action: 'notes.read', on: 'note', from: 'id' } })",
	"c.mutation({ input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ deleted: z.uuid() }), access: { action: 'notes.delete', on: 'note', from: 'id' } })",
	'c.query({ output: z.strictObject({ email: z.email() }), access: { member: true } })',
	"c.mutation({ input: z.strictObject({ name: z.string() }), output: z.strictObject({ id: z.uuid() }), access: { action: 'workspaces.create', creates: 'workspace' } })",
]

function generate(): string {
	const groups: string[] = []
	for (let group = 0; group < PROCEDURES / 10; group++) {
		const procedures = Array.from({ length: 10 }, (_, index) => {
			const number = group * 10 + index
			return `\t\t\tp${number}: ${FORMS[number % FORMS.length]},`
		})
		groups.push(`\t\tg${group}: {\n${procedures.join('\n')}\n\t\t},`)
	}
	return `import { defineContract } from '@fabrika/app/contract'
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
${groups.join('\n')}
	}),
}))
`
}

describe('a contract of 200 procedures', () => {
	test('type-checks without a diagnostic, within the instantiation and time budget', () => {
		const config = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile)
		const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir).options, noEmit: true }
		const source = generate()
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
		const seconds = (performance.now() - started) / 1000
		console.info(`${PROCEDURES} procedures: ${seconds.toFixed(2)} s, ${program.getInstantiationCount()} instantiations`)

		expect(diagnostics).toEqual([])
		expect(program.getInstantiationCount()).toBeLessThan(1_000_000)
		expect(seconds).toBeLessThan(10)
	}, 60_000)
})
