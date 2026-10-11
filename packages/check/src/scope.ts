import { type AstNode, child, children, identifierName, stringField, walk } from './ast'

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement'])

/** The names a binding pattern declares: `x`, `{ a, b: c, ...d }`, `[e = 1]`, a constructor's `private f`. */
const patternNames = (pattern: AstNode | null | undefined): readonly string[] => {
	if (pattern === null || pattern === undefined) return []
	const name = identifierName(pattern)
	if (name !== undefined) return [name]
	switch (pattern.type) {
		case 'ObjectPattern':
			return children(pattern, 'properties').flatMap((property) =>
				property === null ? [] : patternNames(child(property, property.type === 'RestElement' ? 'argument' : 'value'))
			)
		case 'ArrayPattern':
			return children(pattern, 'elements').flatMap(patternNames)
		case 'AssignmentPattern':
			return patternNames(child(pattern, 'left'))
		case 'RestElement':
			return patternNames(child(pattern, 'argument'))
		case 'TSParameterProperty':
			return patternNames(child(pattern, 'parameter'))
		default:
			return []
	}
}

const declaratorNames = (declaration: AstNode | undefined, lexical: boolean): readonly string[] => {
	if (declaration?.type !== 'VariableDeclaration' || (stringField(declaration, 'kind') === 'var') === lexical) return []
	return children(declaration, 'declarations').flatMap((declarator) => (declarator === null ? [] : patternNames(child(declarator, 'id'))))
}

/** What one statement declares in the block it stands in: `let`/`const` (every kind at the top level), functions, classes, imports. */
const statementNames = (statement: AstNode | null, topLevel: boolean): readonly string[] => {
	if (statement === null) return []
	switch (statement.type) {
		case 'VariableDeclaration':
			return topLevel ? [...declaratorNames(statement, true), ...declaratorNames(statement, false)] : declaratorNames(statement, true)
		case 'FunctionDeclaration':
		case 'ClassDeclaration':
		case 'TSImportEqualsDeclaration':
			return patternNames(child(statement, 'id'))
		case 'ImportDeclaration':
			return children(statement, 'specifiers').flatMap((specifier) => (specifier === null ? [] : patternNames(child(specifier, 'local'))))
		case 'ExportNamedDeclaration':
		case 'ExportDefaultDeclaration':
			return statementNames(child(statement, 'declaration') ?? null, topLevel)
		default:
			return []
	}
}

/** `var` names a function body declares anywhere, outside the functions nested in it. */
const varNames = (body: AstNode | undefined): readonly string[] => {
	const names: string[] = []
	if (body === undefined) return names
	walk(body, (node) => {
		if (FUNCTIONS.has(node.type)) return 'skip'
		names.push(...declaratorNames(node, false))
		return undefined
	})
	return names
}

/** The names `scope` declares for the code inside it; empty for a node that opens no scope. */
const declaredNames = (scope: AstNode): readonly string[] => {
	if (FUNCTIONS.has(scope.type)) {
		const own = scope.type === 'FunctionExpression' ? patternNames(child(scope, 'id')) : []
		return [...own, ...children(scope, 'params').flatMap(patternNames), ...varNames(child(scope, 'body'))]
	}
	if (LOOPS.has(scope.type)) return declaratorNames(child(scope, scope.type === 'ForStatement' ? 'init' : 'left'), true)
	switch (scope.type) {
		case 'Program':
			return children(scope, 'body').flatMap((statement) => statementNames(statement, true))
		case 'BlockStatement':
		case 'StaticBlock':
			return children(scope, 'body').flatMap((statement) => statementNames(statement, false))
		case 'SwitchStatement':
			return children(scope, 'cases').flatMap((
				item,
			) => (item === null ? [] : children(item, 'consequent').flatMap((statement) => statementNames(statement, false))))
		case 'CatchClause':
			return patternNames(child(scope, 'param'))
		case 'ClassExpression':
			return patternNames(child(scope, 'id'))
		default:
			return []
	}
}

/**
 * The scope whose declaration `name` denotes at a node with these ancestors: the innermost one that declares it, or
 * `undefined` for a global. A module's imports and top-level declarations belong to its `Program`.
 */
export const declaringScope = (name: string, ancestors: readonly AstNode[]): AstNode | undefined => {
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const scope = ancestors[index]
		if (scope !== undefined && declaredNames(scope).includes(name)) return scope
	}
	return undefined
}
