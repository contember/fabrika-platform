// The type half of the attack suite: compiles type-attacks/attacks.ts with the package's compiler options and
// checks that every statement marked `// attack:` fails to compile, every `// allowed:` one compiles, and no other
// statement has an error. The file is excluded from the package typecheck because it is meant not to compile.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import ts from 'typescript'

const packageDir = join(import.meta.dir, '..', '..')
const attacksFile = join(import.meta.dir, 'type-attacks', 'attacks.ts')

interface Marked {
	readonly kind: 'attack' | 'allowed'
	readonly label: string
	readonly start: number
	readonly end: number
}

function compile(): { readonly marked: readonly Marked[]; readonly errors: readonly number[]; readonly text: string } {
	const config = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile)
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir)
	const program = ts.createProgram([attacksFile], { ...parsed.options, noEmit: true })
	const source = program.getSourceFile(attacksFile)
	if (source === undefined) {
		throw new Error('the attacks file did not load')
	}
	const text = source.getFullText()
	const marked: Marked[] = []
	for (const statement of source.statements) {
		for (const comment of ts.getLeadingCommentRanges(text, statement.pos) ?? []) {
			const match = /^\/\/ (attack|allowed): (.+)$/.exec(text.slice(comment.pos, comment.end))
			const kind = match?.[1]
			if ((kind === 'attack' || kind === 'allowed') && match?.[2] !== undefined) {
				marked.push({ kind, label: match[2], start: statement.getStart(source), end: statement.end })
			}
		}
	}
	const errors = ts.getPreEmitDiagnostics(program, source).flatMap((diagnostic) => diagnostic.start === undefined ? [] : [diagnostic.start])
	return { marked, errors, text }
}

describe('the type attacks', () => {
	const { marked, errors, text } = compile()

	test('the file declares its attacks', () => {
		expect(marked.filter((item) => item.kind === 'attack').length).toBeGreaterThanOrEqual(40)
	})

	for (const item of marked) {
		test(`${item.kind}: ${item.label}`, () => {
			const inside = errors.filter((position) => position >= item.start && position < item.end)
			if (item.kind === 'attack') {
				expect(inside.length).toBeGreaterThan(0)
			} else {
				expect(inside).toEqual([])
			}
		})
	}

	test('no error outside a marked attack', () => {
		const stray = errors.filter((position) => !marked.some((item) => item.kind === 'attack' && position >= item.start && position < item.end))
		expect(stray.map((position) => text.slice(position, position + 60))).toEqual([])
	})
})
