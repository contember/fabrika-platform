import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import ts from 'typescript-platform'

// An outbound request that carries a credential never follows a redirect: depending on the runtime, a followed
// redirect sends custom headers (Workers: every header) and, on 307/308, the body again to the `Location` origin.
// Such a request sets `redirect: 'manual'` (Workers refuse `'error'`) and treats a 3xx as not ok.
//
// This scan catches the plain form only: a `fetch`-named call or a `new Request` whose own object literal names a
// credential in `headers`. Headers built elsewhere, or an init spread into the literal, are not seen, so the rule
// itself (CLAUDE.md, "Outbound requests") still applies to them.

const root = resolve(import.meta.dir, '../..')
const CREDENTIAL = /authorization|bearer|api[-_]?key|secret|token/i

function calleeName(node: ts.Expression): string {
	if (ts.isIdentifier(node)) return node.text
	if (ts.isPropertyAccessExpression(node)) return node.name.text
	return ''
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
	return property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null
}

/** Where a request init literal names a credential in its headers and sets no `redirect`. */
function redirectFollowingCredentials(path: string): string[] {
	const text = readFileSync(path, 'utf8')
	if (!text.includes('fetch') && !text.includes('Request')) return []
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const found: string[] = []
	const visit = (node: ts.Node): void => {
		const args = ts.isCallExpression(node) && /fetch$/i.test(calleeName(node.expression))
			? node.arguments
			: ts.isNewExpression(node) && calleeName(node.expression) === 'Request'
			? node.arguments
			: undefined
		if (args !== undefined) {
			for (const init of args) {
				if (!ts.isObjectLiteralExpression(init)) continue
				const headers = init.properties.find((property) => propertyName(property) === 'headers')
				if (headers === undefined || !CREDENTIAL.test(headers.getText())) continue
				if (init.properties.some((property) => ts.isSpreadAssignment(property) || propertyName(property) === 'redirect')) continue
				found.push(`${path.slice(root.length + 1)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	return found
}

describe('an outbound request that carries a credential', () => {
	test('always says what a redirect does', async () => {
		const found: string[] = []
		let scanned = 0
		for await (const file of new Bun.Glob('{packages,examples}/**/src/**/*.{ts,tsx}').scan({ cwd: root })) {
			if (file.includes('/node_modules/') || file.includes('/__tests__/') || /\.test\.tsx?$/.test(file)) continue
			scanned++
			found.push(...redirectFollowingCredentials(join(root, file)))
		}
		expect(scanned).toBeGreaterThan(500)
		expect(found).toEqual([])
	})

	test('the scan finds each plain form', () => {
		const path = join(import.meta.dir, 'fixtures/credentialed-fetch.ts')
		expect(redirectFollowingCredentials(path).map((at) => Number(at.split(':').at(-1)))).toEqual([5, 7, 9])
	})
})
