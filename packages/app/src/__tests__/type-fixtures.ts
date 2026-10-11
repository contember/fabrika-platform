// Compiles a directory of mistake fixtures with the package's compiler options. Each fixture marks its mistake with
// `// mistake:` on the line before it; the repository forbids `@ts-expect-error`, so the fixtures are excluded from
// the package typecheck and compiled here instead. A fixture may be a subdirectory: its files without a marker are
// companions (a contract that mounts the fixture's group), and they must compile clean. A `// follow-up:` marker
// admits one more diagnostic on the line after it: a consequence the compiler reports where the mistake is used.

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const packageDir = join(import.meta.dir, '..', '..')

interface Diagnostic {
	readonly line: number
	readonly text: string
}

/** Every `.ts` file under `dir`, by its path relative to `dir`. */
function fixtureFiles(dir: string): readonly string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)))
		.sort()
}

/** The diagnostics of every file under `dir`, compiled as one program with the package's compiler options. */
export function compileFixtures(dir: string): ReadonlyMap<string, readonly Diagnostic[]> {
	const config = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile)
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir)
	const files = fixtureFiles(dir)
	const program = ts.createProgram(
		files.map((file) => join(dir, file)),
		{ ...parsed.options, noEmit: true },
	)
	const byFile = new Map<string, Diagnostic[]>()
	for (const file of files) {
		const source = program.getSourceFile(join(dir, file))
		if (source === undefined) {
			throw new Error(`${file} did not load`)
		}
		byFile.set(
			file,
			ts.getPreEmitDiagnostics(program, source).map((diagnostic) => ({
				line: diagnostic.start === undefined ? -1 : source.getLineAndCharacterOfPosition(diagnostic.start).line,
				text: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
			})),
		)
	}
	return byFile
}

/** The zero-based line after the `// mistake:` marker, or -1 for a companion. */
function markedLine(dir: string, file: string): number {
	const lines = readFileSync(join(dir, file), 'utf8').split('\n')
	const marker = lines.findIndex((line) => line.trim().startsWith('// mistake:'))
	return marker === -1 ? -1 : marker + 1
}

/** The zero-based lines after each `// follow-up:` marker. */
function followUpLines(dir: string, file: string): readonly number[] {
	const lines = readFileSync(join(dir, file), 'utf8').split('\n')
	return lines.flatMap((line, index) => (line.trim().startsWith('// follow-up:') ? [index + 1] : []))
}

export interface MistakeOptions {
	/**
	 * Each diagnostic is at most two lines and prints no `never`, no truncated type (`...`) and no mapped or object
	 * type: what an agent reads has to name the fix, not the framework's types.
	 */
	readonly plain?: boolean
	/** Fixtures held to the expected text and line only: their diagnostic is the compiler's own elaboration. */
	readonly elaborated?: readonly string[]
}

const DUMPED = ['...', '{ readonly ', '[K in', ' in keyof ']

/**
 * One test per fixture: it fails to compile, every diagnostic sits on the marked line, and one of them contains the
 * expected text. Every marked file needs an expectation and every expectation a marked file; every companion compiles
 * clean.
 */
export function expectMistakes(dir: string, expected: Readonly<Record<string, string>>, options: MistakeOptions = {}): void {
	const diagnostics = compileFixtures(dir)
	const marked = [...diagnostics.keys()].filter((file) => markedLine(dir, file) !== -1)
	const companions = [...diagnostics.keys()].filter((file) => markedLine(dir, file) === -1)

	test('every fixture has an expectation, and every expectation a fixture', () => {
		expect(marked).toEqual(Object.keys(expected).sort())
	})

	for (const companion of companions) {
		test(`${companion} compiles clean: the mistake is reported where it is made`, () => {
			expect(diagnostics.get(companion) ?? []).toEqual([])
		})
	}

	for (const [file, text] of Object.entries(expected)) {
		test(file, () => {
			const found = diagnostics.get(file) ?? []
			expect(found.length).toBeGreaterThan(0)
			expect(found.map((diagnostic) => diagnostic.text).join('\n')).toContain(text)
			const line = markedLine(dir, file)
			expect(line).toBeGreaterThan(0)
			expect(found.filter((diagnostic) => diagnostic.line === line).length).toBeGreaterThan(0)
			const allowed = [line, ...followUpLines(dir, file)]
			expect(found.filter((diagnostic) => !allowed.includes(diagnostic.line))).toEqual([])
			if (options.plain === true && !(options.elaborated ?? []).includes(file)) {
				for (const { text: message } of found) {
					expect(message.split('\n').length).toBeLessThanOrEqual(2)
					expect(message).not.toMatch(/\bnever\b/)
					for (const dump of DUMPED) {
						expect(message).not.toContain(dump)
					}
				}
			}
		})
	}
}
