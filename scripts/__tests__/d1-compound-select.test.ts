import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import ts from 'typescript-platform'

// D1 refuses a compound SELECT of more than five terms ("too many terms in compound SELECT"), while bun:sqlite and
// Postgres, which the tests run on, accept it, so a longer one fails only on Cloudflare. Ask several questions in one
// row instead: a column per question, `CASE WHEN EXISTS (…) THEN 1 ELSE 0 END`.
//
// This scan counts UNION, INTERSECT and EXCEPT in each string or template literal of the source. A compound SELECT
// assembled at runtime (`.join(' UNION ')`) is not seen, so the limit still applies to it by review.

const root = resolve(import.meta.dir, '../..')
const D1_MAX_COMPOUND_TERMS = 5
/** The Postgres, S3 and Bun implementation set never runs on Cloudflare. */
const POSTGRES_ONLY = 'packages/platform-node/'
// Upper case, as this repository writes SQL keywords: prose such as "every field except" is not counted.
const COMPOUND_OPERATOR = /\b(?:UNION|INTERSECT|EXCEPT)\b/g

/** Where a literal holds a compound SELECT of more terms than D1 accepts. */
function compoundSelectsOverD1Limit(path: string, text: string): string[] {
	if (!/\b(?:UNION|INTERSECT|EXCEPT)\b/.test(text)) return []
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const found: string[] = []
	const visit = (node: ts.Node): void => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
			const terms = (node.getText().match(COMPOUND_OPERATOR)?.length ?? 0) + 1
			if (terms > D1_MAX_COMPOUND_TERMS) found.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
			return
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	return found
}

describe('a compound SELECT', () => {
	test('has at most as many terms as D1 accepts', async () => {
		const found: string[] = []
		let scanned = 0
		for await (const file of new Bun.Glob('packages/**/src/**/*.ts').scan({ cwd: root })) {
			if (file.startsWith(POSTGRES_ONLY) || file.includes('/node_modules/') || file.includes('/__tests__/') || file.endsWith('.test.ts')) continue
			scanned++
			found.push(...compoundSelectsOverD1Limit(file, readFileSync(join(root, file), 'utf8')))
		}
		expect(scanned).toBeGreaterThan(500)
		expect(found).toEqual([])
	})

	test('the scan counts the terms of one literal', () => {
		const terms = (count: number): string => Array.from({ length: count }, (_, index) => `SELECT ${index} FROM t WHERE app = ?`).join('\n\tUNION ')
		const source = [
			`const allowed = \`${terms(D1_MAX_COMPOUND_TERMS)}\``,
			`const refused = \`${terms(D1_MAX_COMPOUND_TERMS + 1)}\``,
			`const split = ['${terms(3)}', '${terms(3)}']`,
		].join('\n')
		const refusedLine = source.split('\n').findIndex((line) => line.startsWith('const refused')) + 1
		expect(compoundSelectsOverD1Limit('fixture.ts', source)).toEqual([`fixture.ts:${refusedLine}`])
	})
})
