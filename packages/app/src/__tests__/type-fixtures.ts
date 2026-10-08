// Compiles a directory of mistake fixtures with the package's compiler options. Each fixture marks its mistake with
// `// mistake:` on the line before it; the repository forbids `@ts-expect-error`, so the fixtures are excluded from
// the package typecheck and compiled here instead.

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const packageDir = join(import.meta.dir, '..', '..')

interface Diagnostic {
	readonly line: number
	readonly text: string
}

function compile(dir: string): ReadonlyMap<string, readonly Diagnostic[]> {
	const config = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile)
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir)
	const files = readdirSync(dir).filter((file) => file.endsWith('.ts')).map((file) => join(dir, file))
	const program = ts.createProgram(files, { ...parsed.options, noEmit: true })
	const byFile = new Map<string, Diagnostic[]>()
	for (const file of files) {
		const source = program.getSourceFile(file)
		if (source === undefined) {
			throw new Error(`${file} did not load`)
		}
		byFile.set(
			file.slice(dir.length + 1),
			ts.getPreEmitDiagnostics(program, source).map((diagnostic) => ({
				line: diagnostic.start === undefined ? -1 : source.getLineAndCharacterOfPosition(diagnostic.start).line,
				text: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
			})),
		)
	}
	return byFile
}

/** The zero-based line after the `// mistake:` marker. */
function markedLine(dir: string, file: string): number {
	const lines = readFileSync(join(dir, file), 'utf8').split('\n')
	return lines.findIndex((line) => line.trim().startsWith('// mistake:')) + 1
}

/**
 * One test per fixture: it fails to compile, every diagnostic sits on the marked line, and one of them contains the
 * expected text. Every fixture needs an expectation and every expectation a fixture.
 */
export function expectMistakes(dir: string, expected: Readonly<Record<string, string>>): void {
	const diagnostics = compile(dir)

	test('every fixture has an expectation, and every expectation a fixture', () => {
		expect([...diagnostics.keys()].sort()).toEqual(Object.keys(expected).sort())
	})

	for (const [file, text] of Object.entries(expected)) {
		test(file, () => {
			const found = diagnostics.get(file) ?? []
			expect(found.length).toBeGreaterThan(0)
			expect(found.map((diagnostic) => diagnostic.text).join('\n')).toContain(text)
			const line = markedLine(dir, file)
			expect(line).toBeGreaterThan(0)
			expect(found.map((diagnostic) => diagnostic.line)).toEqual(found.map(() => line))
		})
	}
}
