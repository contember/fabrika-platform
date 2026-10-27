import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import ts from 'typescript'

// workerd refuses the global `fetch` called with any other `this` ("Illegal invocation"); Bun does not, so no test of
// the code that stores it notices. Stored as a property, a parameter property or an object field, it is called as a
// method sooner or later: `this.fetch(…)`, `deps.fetch(…)`. The fix is a wrapper, `(input, init) => fetch(input, init)`.

const root = resolve(import.meta.dir, '../..')

/** Whether `node` names the global `fetch`: `globalThis.fetch`, `self.fetch`, or a `fetch` no enclosing scope declares. */
function isGlobalFetch(node: ts.Node): boolean {
	if (ts.isPropertyAccessExpression(node)) {
		return node.name.text === 'fetch' && ts.isIdentifier(node.expression) && ['globalThis', 'self'].includes(node.expression.text)
	}
	if (!ts.isIdentifier(node) || node.text !== 'fetch') return false
	const parent = node.parent
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
	if ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent)) && parent.name === node) return false
	for (let scope: ts.Node | undefined = parent; scope !== undefined; scope = scope.parent) {
		if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'fetch')) {
			return false
		}
		if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
			for (const statement of scope.statements) {
				if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'fetch') return false
				if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings !== undefined) {
					const bindings = statement.importClause.namedBindings
					if (ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === 'fetch')) return false
				}
				if (
					ts.isVariableStatement(statement)
					&& statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'fetch')
				) return false
			}
		}
	}
	return true
}

/** Whether the value `node` evaluates to is kept where a later call would pass a `this`. */
function isStored(node: ts.Node): boolean {
	let value = node
	while (
		ts.isParenthesizedExpression(value.parent)
		|| ts.isConditionalExpression(value.parent)
		|| (ts.isBinaryExpression(value.parent) && value.parent.right === value
			&& [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.parent.operatorToken.kind))
	) value = value.parent
	const parent = value.parent
	if (ts.isPropertyAssignment(parent) && parent.initializer === value) return true
	if (ts.isPropertyDeclaration(parent) && parent.initializer === value) return true
	if (ts.isParameter(parent) && parent.initializer === value) return ts.getModifiers(parent) !== undefined
	if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === value) {
		return ts.isPropertyAccessExpression(parent.left) || ts.isElementAccessExpression(parent.left)
	}
	return false
}

function storedGlobalFetches(path: string): string[] {
	const text = readFileSync(path, 'utf8')
	if (!text.includes('fetch')) return []
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
	const found: string[] = []
	const visit = (node: ts.Node): void => {
		if (isGlobalFetch(node) && isStored(node)) {
			// A test that swaps the global and puts it back assigns `globalThis.fetch` itself, which is no stored copy.
			const parent = node.parent
			const restoresGlobal = ts.isBinaryExpression(parent) && isGlobalFetch(parent.left)
			if (!restoresGlobal) found.push(`${path.slice(root.length + 1)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	return found
}

describe('the global fetch', () => {
	test('is never stored where it would be called as a method', async () => {
		const found: string[] = []
		let scanned = 0
		for await (const file of new Bun.Glob('{packages,examples}/**/src/**/*.{ts,tsx}').scan({ cwd: root })) {
			if (file.includes('/node_modules/') || file.includes('/__tests__/') || /\.test\.tsx?$/.test(file)) continue
			scanned++
			found.push(...storedGlobalFetches(join(root, file)))
		}
		expect(scanned).toBeGreaterThan(500)
		expect(found).toEqual([])
	})

	test('the scan finds each way of storing it', () => {
		const path = join(import.meta.dir, 'fixtures/stored-global-fetch.ts')
		expect(storedGlobalFetches(path).map((at) => Number(at.split(':').at(-1)))).toEqual([4, 6, 9, 12])
	})
})
