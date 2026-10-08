// The type half of `defineContract`: each file in contract-mistakes/ is one mistake a coding agent makes, marked
// `// mistake:` on the line before it. The package's compiler options must refuse exactly that line, with the
// diagnostic text below. The repository forbids `@ts-expect-error`, so the files are compiled here and excluded
// from the package typecheck. The parser spike's mistakes 05–10 are handler mistakes and belong to `implement`.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const packageDir = join(import.meta.dir, '..', '..')
const mistakesDir = join(import.meta.dir, 'contract-mistakes')

const EXPECTED: Readonly<Record<string, string>> = {
	'01-forgot-access.ts': "Property 'access' is missing",
	'02-rpc-with-public-caller.ts': `Type '"public"' is not assignable to type 'RpcCaller'`,
	'03-action-typo.ts': `Did you mean '"notes.read"'?`,
	'04-wildcard-role.ts': `Type '"*"' is not assignable to type`,
	'11-loose-input.ts': 'a loose object admits undeclared keys: declare it with z.strictObject({ … })',
	'12-from-field-not-in-input.ts': `Type '"noteId"' is not assignable to type '"id"'`,
	'13-creates-dimension-without-creator.ts': `Type '"note"' is not assignable to type '"workspace"'`,
	'14-link-caller-on-rpc-mount.ts': `Type '"link"' is not assignable to type 'RpcCaller'`,
	'15-loose-output.ts': 'a loose object admits undeclared keys: declare it with z.strictObject({ … })',
	'16-wildcard-action.ts': 'an action is exact: a role grants listed actions, and * is not an action',
	'17-mutation-in-export.ts': `Type '"mutation"' is not assignable to type '"query"'`,
	'18-link-procedure-outside-grants.ts': `Type '"notes.delete"' is not assignable to type '"notes.read"'`,
	'19-options-set-builder-fields.ts': `is not assignable to type 'Owned<"kind" | "path">'`,
}

interface Diagnostic {
	readonly line: number
	readonly text: string
}

function compile(): ReadonlyMap<string, readonly Diagnostic[]> {
	const config = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile)
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir)
	const files = readdirSync(mistakesDir).filter((file) => file.endsWith('.ts')).map((file) => join(mistakesDir, file))
	const program = ts.createProgram(files, { ...parsed.options, noEmit: true })
	const byFile = new Map<string, Diagnostic[]>()
	for (const file of files) {
		const source = program.getSourceFile(file)
		if (source === undefined) {
			throw new Error(`${file} did not load`)
		}
		byFile.set(
			file.slice(mistakesDir.length + 1),
			ts.getPreEmitDiagnostics(program, source).map((diagnostic) => ({
				line: diagnostic.start === undefined ? -1 : source.getLineAndCharacterOfPosition(diagnostic.start).line,
				text: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
			})),
		)
	}
	return byFile
}

/** The zero-based line after the `// mistake:` marker. */
function markedLine(file: string): number {
	const lines = readFileSync(join(mistakesDir, file), 'utf8').split('\n')
	return lines.findIndex((line) => line.trim().startsWith('// mistake:')) + 1
}

describe('the contract mistakes are type errors', () => {
	const diagnostics = compile()

	test('every fixture has an expectation, and every expectation a fixture', () => {
		expect([...diagnostics.keys()].sort()).toEqual(Object.keys(EXPECTED).sort())
	})

	for (const [file, text] of Object.entries(EXPECTED)) {
		test(file, () => {
			const found = diagnostics.get(file) ?? []
			expect(found.length).toBeGreaterThan(0)
			expect(found.map((diagnostic) => diagnostic.text).join('\n')).toContain(text)
			const line = markedLine(file)
			expect(line).toBeGreaterThan(0)
			expect(found.map((diagnostic) => diagnostic.line)).toEqual(found.map(() => line))
		})
	}
})
