import { type AstNode, child, children, identifierName, memberPath, memberSuffix, staticString, walk } from '../ast'
import type { Finding, Report } from '../finding'
import { declaringScope } from '../scope'
import { isKey, parseToml } from '../toml'
import { BUNFIG_FILE } from '../trust'

const TEST_ROOTS = new Set(['test', 'it', 'describe', 'bench'])
const NOT_RUN = new Set(['skip', 'only', 'todo', 'skipIf', 'if', 'todoIf', 'failing'])
const NOT_RUN_ALIASES = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe'])
/** Modifiers that still register a test that runs: `test.concurrent(…)`, `test.each(table)(…)`. */
const RUNNING_MODIFIERS = new Set(['concurrent', 'serial', 'each'])
const ASSERTION_NAME = /^(?:expect|assert)/
const FUNCTION_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'])

const isFunction = (node: AstNode | null | undefined): node is AstNode => node !== null && node !== undefined && FUNCTION_TYPES.has(node.type)

/** `expect(x).toBe(y)`, `expect(x).not.toThrow()`: a matcher called on the result of `expect(…)`. */
const isMatcherCall = (callee: AstNode): boolean => {
	let current = child(callee, 'object')
	while (current?.type === 'MemberExpression') current = child(current, 'object')
	return current?.type === 'CallExpression' && identifierName(child(current, 'callee')) === 'expect'
}

/** A matcher on `expect(…)`, or a call of an assertion helper: `assert(…)`, `assert.equal(…)`, `harness.expectDenied(…)`. */
const isAssertionCall = (node: AstNode): boolean => {
	const callee = node.type === 'CallExpression' ? child(node, 'callee') : undefined
	if (callee === undefined) return false
	const name = identifierName(callee)
	if (name !== undefined) return name !== 'expect' && ASSERTION_NAME.test(name)
	if (callee.type !== 'MemberExpression') return false
	if (isMatcherCall(callee)) return true
	const path = memberPath(callee)
	const [root] = path ?? []
	const last = path?.[path.length - 1]
	return root !== undefined && root !== 'expect' && (root.startsWith('assert') || (last !== undefined && ASSERTION_NAME.test(last)))
}

/** Whether a test body runs an assertion; a nested function counts only where it is called or passed to a call. */
const hasAssertion = (body: AstNode): boolean => {
	let found = false
	walk(body, (node, ancestors) => {
		if (found) return 'skip'
		if (node !== body && FUNCTION_TYPES.has(node.type)) {
			const parent = ancestors[ancestors.length - 1]
			const isInvoked = parent?.type === 'CallExpression' && (parent['callee'] === node || children(parent, 'arguments').includes(node))
			if (!isInvoked) return 'skip'
		}
		if (isAssertionCall(node)) found = true
	})
	return found
}

/** The path a registration is called through: `test.concurrent(…)` → `test.concurrent`; `test.each(t)(…)` → `test.each`. */
const registrationPath = (node: AstNode): readonly string[] | undefined => {
	const callee = child(node, 'callee')
	if (callee?.type !== 'CallExpression') return callee === undefined ? undefined : memberPath(callee)
	const inner = child(callee, 'callee')
	const path = inner === undefined ? undefined : memberPath(inner)
	return path?.[path.length - 1] === 'each' ? path : undefined
}

/** The name of `bun:test`'s export a module's own `local` binding imports, if it imports one. */
const bunTestImport = (program: AstNode, local: string): string | undefined => {
	for (const statement of children(program, 'body')) {
		if (statement?.type !== 'ImportDeclaration' || staticString(child(statement, 'source')) !== 'bun:test') continue
		for (const specifier of children(statement, 'specifiers')) {
			if (specifier?.type === 'ImportSpecifier' && identifierName(child(specifier, 'local')) === local) {
				return identifierName(child(specifier, 'imported')) ?? staticString(child(specifier, 'imported'))
			}
		}
	}
	return undefined
}

/** What a call rooted at `root` reaches: the global, `bun:test`'s export it imports, or nothing for the module's own binding. */
const runnerName = (root: string, ancestors: readonly AstNode[]): string | undefined => {
	const scope = declaringScope(root, ancestors)
	if (scope === undefined) return root
	return scope.type === 'Program' ? bunTestImport(scope, root) : undefined
}

/** For test files: every test runs, and every test asserts. */
export const checkTestNode = (node: AstNode, ancestors: readonly AstNode[], report: Report): void => {
	if (node.type !== 'CallExpression') return
	const path = registrationPath(node)
	if (path === undefined) return
	const [root, ...modifiers] = path
	if (root === undefined) return
	const notRun = TEST_ROOTS.has(root) ? modifiers.find((modifier) => NOT_RUN.has(modifier)) : undefined
	const isAlias = modifiers.length === 0 && NOT_RUN_ALIASES.has(root) && NOT_RUN_ALIASES.has(runnerName(root, ancestors) ?? '')
	if (notRun !== undefined || isAlias) {
		if (child(node, 'callee')?.type !== 'CallExpression') {
			report(node, 'skipped-test', `${path.join('.')} leaves tests out of the run`, 'a test that runs, or no test at all')
		}
		return
	}
	if ((root !== 'test' && root !== 'it') || !modifiers.every((modifier) => RUNNING_MODIFIERS.has(modifier))) return
	const body = children(node, 'arguments').find(isFunction)
	if (body !== undefined && !hasAssertion(body)) {
		report(
			node,
			'test-without-assertion',
			`this ${path.join('.')}() asserts nothing, so it passes whatever the code does`,
			'a matcher on expect(…), such as expect(x).toBe(y), or a call of a helper named expect…/assert…',
		)
	}
}

/** `[test]` keys that pick other test files, skip some, or let a failing test pass on a later attempt. */
const SUITE_NARROWING_TEST_KEYS = ['root', 'pathIgnorePatterns', 'retry'] as const

/**
 * The `bunfig.toml` of an application must not narrow its own suite, which the platform build runs. A file outside the
 * TOML subset is reported by the trust rules.
 */
export const checkTestSuiteConfig = (text: string): Finding[] => {
	const document = parseToml(text)
	if (!document.ok) return []
	const findings: Finding[] = []
	for (const entry of document.entries) {
		for (const key of SUITE_NARROWING_TEST_KEYS) {
			if (isKey(entry, 'test', key)) {
				findings.push({
					file: BUNFIG_FILE,
					line: entry.line,
					column: 1,
					severity: 'refusal',
					rule: 'skipped-test',
					message: `[test] ${key} changes which tests run or whether a failure counts`,
					allowed: 'no [test] root, pathIgnorePatterns or retry in bunfig.toml',
				})
			}
		}
	}
	return findings
}

/**
 * `mock.module(…)` of the test runner or a framework package would let application code replace what the test kit runs
 * on; a computed specifier could name either. Refused anywhere in the application.
 */
export const checkMockModule = (node: AstNode, report: Report): void => {
	if (node.type !== 'CallExpression') return
	const callee = child(node, 'callee')
	if (callee === undefined || callee.type !== 'MemberExpression') return
	const suffix = memberPath(callee) ?? memberSuffix(callee)
	if (suffix.length < 2 || suffix[suffix.length - 1] !== 'module' || suffix[suffix.length - 2] !== 'mock') return
	const allowed = 'mock.module of an application module, with a literal specifier'
	const specifier = staticString(children(node, 'arguments')[0] ?? undefined)
	if (specifier === undefined) {
		report(node, 'mock-module', 'mock.module with a computed specifier could replace the test runner or the framework', allowed)
		return
	}
	if (specifier === 'bun:test' || specifier.startsWith('@fabrika/')) {
		report(node, 'mock-module', `mock.module('${specifier}') replaces what the test kit runs on`, allowed)
	}
}
