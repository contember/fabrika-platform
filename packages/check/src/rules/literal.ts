import { type AstNode, child, children, identifierName, type ParsedModule, staticKey, stringField, stringLiteral } from '../ast'
import { type Finding, type Report, reporter } from '../finding'
import { isRelativeSpecifier, joinRelative, resolutionCandidates } from '../layout'

/** The only imported names a literal module may call: the builders the platform reads statically. */
const CALL_ROOTS: Readonly<Record<string, readonly string[]>> = {
	'zod/v4': ['z', '*'],
	'@fabrika/app/contract': ['defineContract', 'defineTables'],
}

/** Zod methods whose result cannot be serialized, or that accept keys the schema does not declare. */
const UNSERIALIZABLE_SCHEMA_METHODS = new Set([
	'transform',
	'refine',
	'superRefine',
	'preprocess',
	'passthrough',
	'loose',
	'looseObject',
	'catchall',
	'catch',
	'pipe',
	'custom',
])

const ALLOWED_VALUE = 'object and array literals, strings, numbers, booleans, null, the c.* and z.* calls, and const imports of such values'

interface Imported {
	readonly specifier: string
	readonly imported: string
}

interface PendingReference {
	readonly name: string
	readonly node: AstNode
}

interface LiteralSummary {
	readonly file: string
	readonly imports: ReadonlyMap<string, Imported>
	/** Top-level consts whose initializer is a literal, which other literal modules may import. */
	readonly literalConsts: ReadonlySet<string>
	/** Imported identifiers used as values, resolved once every module of the graph is read. */
	readonly pendingReferences: readonly PendingReference[]
	readonly report: Report
}

const importedName = (specifier: AstNode): string => {
	if (specifier.type === 'ImportNamespaceSpecifier') return '*'
	if (specifier.type === 'ImportDefaultSpecifier') return 'default'
	const imported = child(specifier, 'imported')
	return identifierName(imported) ?? stringLiteral(imported) ?? ''
}

/** The statement a top-level `export` wraps, or the statement itself. */
const declarationOf = (statement: AstNode): AstNode => {
	if (statement.type !== 'ExportNamedDeclaration') return statement
	return child(statement, 'declaration') ?? statement
}

const constNames = (program: AstNode): { readonly consts: ReadonlySet<string>; readonly others: ReadonlySet<string> } => {
	const consts = new Set<string>()
	const others = new Set<string>()
	for (const statement of children(program, 'body')) {
		if (statement === null) continue
		const declaration = declarationOf(statement)
		if (declaration.type !== 'VariableDeclaration') continue
		for (const declarator of children(declaration, 'declarations')) {
			const name = declarator ? identifierName(child(declarator, 'id')) : undefined
			if (name !== undefined) (stringField(declaration, 'kind') === 'const' ? consts : others).add(name)
		}
	}
	return { consts, others }
}

const readModule = (module: ParsedModule, findings: Finding[]): LiteralSummary => {
	const report = reporter(module.file, findings)
	const imports = new Map<string, Imported>()
	const callRoots = new Set<string>()
	const literalConsts = new Set<string>()
	const pendingReferences: PendingReference[] = []
	const { consts, others } = constNames(module.program)
	let reported = 0
	const fail = (node: AstNode, message: string, allowed: string = ALLOWED_VALUE) => {
		reported++
		report(node, 'literal', message, allowed)
	}

	const checkIdentifier = (node: AstNode, scope: ReadonlySet<string>): void => {
		const name = identifierName(node) ?? ''
		if (scope.has(name) || callRoots.has(name)) return fail(node, `'${name}' used as a value`, `${name}.<builder>(…) calls only`)
		if (consts.has(name)) return
		if (imports.has(name)) {
			pendingReferences.push({ name, node })
			return
		}
		if (others.has(name)) return fail(node, `'${name}' is not a const`, 'a top-level const in this file, or a named import of one')
		fail(node, `unknown identifier '${name}'`, 'a top-level const in this file, or a named import of one')
	}

	/** The identifier a call chain starts from (`z.string().min(1)` → `z`); reports an unserializable method on the way. */
	const callChainRoot = (callee: AstNode): AstNode | undefined => {
		let current: AstNode | undefined = callee
		while (current !== undefined) {
			if (current.type === 'Identifier') return current
			if (current.type === 'CallExpression') {
				current = child(current, 'callee')
				continue
			}
			if (current.type !== 'MemberExpression' || current['computed'] === true) return undefined
			const method = staticKey(current, 'property')
			if (method !== undefined && UNSERIALIZABLE_SCHEMA_METHODS.has(method)) {
				fail(current, `'.${method}()' makes the schema unserializable`, 'a serializable schema: strict objects, no transforms, refinements or pipes')
				return undefined
			}
			current = child(current, 'object')
		}
		return undefined
	}

	const checkCallArguments = (call: AstNode, root: AstNode, scope: ReadonlySet<string>): void => {
		let current: AstNode | undefined = call
		while (current !== undefined && current !== root) {
			if (current.type === 'CallExpression') {
				if (current['optional'] === true) fail(current, 'optional call', 'a plain call')
				for (const argument of children(current, 'arguments')) {
					if (argument === null) continue
					if (argument.type === 'SpreadElement') fail(argument, 'spread', 'the arguments written out')
					else checkExpression(argument, scope)
				}
				current = child(current, 'callee')
			} else current = child(current, 'object')
		}
	}

	const checkCall = (node: AstNode, scope: ReadonlySet<string>): void => {
		const before = reported
		const callee = child(node, 'callee')
		const root = callee === undefined ? undefined : callChainRoot(callee)
		if (reported > before) return
		const rootName = identifierName(root) ?? ''
		if (root === undefined || !(callRoots.has(rootName) || scope.has(rootName))) {
			return fail(node, 'call of a function that is not c.*, z.* or define*', 'the value the function returns, written as a literal')
		}
		checkCallArguments(node, root, scope)
	}

	const checkArrow = (node: AstNode, scope: ReadonlySet<string>): void => {
		const parameters = children(node, 'params')
		const parameter = parameters[0]
		const body = child(node, 'body')
		const parameterName = parameters.length === 1 && parameter ? identifierName(parameter) : undefined
		if (parameterName === undefined || body === undefined || body.type === 'BlockStatement' || node['async'] === true) {
			return fail(node, 'function', 'a builder callback with one parameter and an expression body: (c) => ({ … })')
		}
		checkExpression(body, new Set([...scope, parameterName]))
	}

	const checkObject = (node: AstNode, scope: ReadonlySet<string>): void => {
		for (const property of children(node, 'properties')) {
			if (property === null) continue
			if (property.type === 'SpreadElement') {
				fail(property, 'spread', 'the entries written out')
				continue
			}
			if (property['computed'] === true) {
				fail(property, 'computed key', 'a plain or quoted key')
				continue
			}
			if (property['kind'] !== 'init' || property['method'] === true) {
				fail(property, 'method or accessor', 'a property with a literal value')
				continue
			}
			const value = child(property, 'value')
			if (value !== undefined) checkExpression(value, scope)
		}
	}

	const checkExpression = (node: AstNode, scope: ReadonlySet<string>): void => {
		switch (node.type) {
			case 'Literal':
				if (node['regex'] !== undefined) {
					return fail(node, 'regular expression literal', 'a z.string() format check such as .uuid(), .email(), .min() or .max()')
				}
				if (node['bigint'] !== undefined) return fail(node, 'bigint literal', 'a number or a string')
				return
			case 'TemplateLiteral':
				if (children(node, 'expressions').length > 0) return fail(node, 'template literal with ${…}', 'a plain string')
				return
			case 'UnaryExpression': {
				const argument = child(node, 'argument')
				if (node['operator'] === '-' && argument?.type === 'Literal' && typeof argument['value'] === 'number') return
				return fail(node, `unary '${String(node['operator'])}'`, 'the resulting value written as a literal')
			}
			case 'ParenthesizedExpression':
			case 'TSSatisfiesExpression': {
				const inner = child(node, 'expression')
				if (inner !== undefined) checkExpression(inner, scope)
				return
			}
			case 'TSAsExpression': {
				const inner = child(node, 'expression')
				const type = child(node, 'typeAnnotation')
				const isConst = type?.type === 'TSTypeReference' && identifierName(child(type, 'typeName')) === 'const'
				if (!isConst) return fail(node, 'type assertion `as T`', '`as const` or `satisfies T`')
				if (inner !== undefined) checkExpression(inner, scope)
				return
			}
			case 'ArrayExpression':
				for (const element of children(node, 'elements')) {
					if (element === null) fail(node, 'array hole', 'every element written out')
					else if (element.type === 'SpreadElement') fail(element, 'spread', 'the elements written out')
					else checkExpression(element, scope)
				}
				return
			case 'ObjectExpression':
				return checkObject(node, scope)
			case 'Identifier':
				return checkIdentifier(node, scope)
			case 'ArrowFunctionExpression':
				return checkArrow(node, scope)
			case 'CallExpression':
				return checkCall(node, scope)
			case 'BinaryExpression':
			case 'LogicalExpression':
				return fail(node, `operator '${String(node['operator'])}'`, 'the resulting value written as a literal')
			default:
				return fail(node, `${node.type} is not a literal`, ALLOWED_VALUE)
		}
	}

	const checkImport = (statement: AstNode): void => {
		const specifier = stringLiteral(child(statement, 'source')) ?? ''
		const specifiers = children(statement, 'specifiers').filter((item): item is AstNode => item !== null)
		if (specifiers.length === 0) return fail(statement, `side-effect import of '${specifier}'`, 'named imports of literal consts')
		if (stringField(statement, 'importKind') === 'type') return
		for (const item of specifiers) {
			if (stringField(item, 'importKind') === 'type') continue
			const local = identifierName(child(item, 'local'))
			if (local === undefined) continue
			const imported = importedName(item)
			imports.set(local, { specifier, imported })
			if (CALL_ROOTS[specifier]?.includes(imported)) callRoots.add(local)
		}
	}

	const checkConstDeclaration = (declaration: AstNode): void => {
		for (const declarator of children(declaration, 'declarations')) {
			if (declarator === null) continue
			const name = identifierName(child(declarator, 'id'))
			const init = child(declarator, 'init')
			if (name === undefined || init === undefined) {
				fail(declarator, 'destructuring or a missing initializer', 'const <name> = <literal>')
				continue
			}
			const before = reported
			checkExpression(init, new Set())
			if (reported === before) literalConsts.add(name)
		}
	}

	for (const statement of children(module.program, 'body')) {
		if (statement === null) continue
		if (statement.type === 'ImportDeclaration') {
			checkImport(statement)
			continue
		}
		const declaration = declarationOf(statement)
		if (declaration.type === 'TSTypeAliasDeclaration' || declaration.type === 'TSInterfaceDeclaration') continue
		if (declaration.type === 'ExportNamedDeclaration') {
			if (child(declaration, 'source') !== undefined) fail(declaration, 're-export', 'import the const, then export it')
			continue
		}
		if (declaration.type === 'ExportDefaultDeclaration') {
			const exported = child(declaration, 'declaration')
			if (exported !== undefined) checkExpression(exported, new Set())
			continue
		}
		if (declaration.type === 'VariableDeclaration') {
			const kind = stringField(declaration, 'kind') ?? ''
			if (kind === 'const') checkConstDeclaration(declaration)
			else fail(declaration, `'${kind}' declaration`, 'a top-level const')
			continue
		}
		fail(statement, `top-level ${declaration.type}`, 'only imports, types and const declarations of literals; move code out of the contract graph')
	}
	return { file: module.file, imports, literalConsts, pendingReferences, report }
}

const resolveModule = (from: string, specifier: string, modules: ReadonlyMap<string, ParsedModule>): string | undefined => {
	const base = joinRelative(from, specifier)
	return base === undefined ? undefined : resolutionCandidates(base).find((candidate) => modules.has(candidate))
}

/**
 * The contract, its schema modules and the table policies are literals (D5), so that the platform can read them from a
 * commit without executing them. `entries` are the graph's roots; relative value imports pull further modules in.
 */
export const checkLiteralGraph = (entries: readonly string[], modules: ReadonlyMap<string, ParsedModule>): Finding[] => {
	const findings: Finding[] = []
	const summaries = new Map<string, LiteralSummary>()
	const queue = entries.filter((entry) => modules.has(entry))
	while (queue.length > 0) {
		const file = queue.shift()
		const module = file === undefined ? undefined : modules.get(file)
		if (module === undefined || summaries.has(module.file)) continue
		const summary = readModule(module, findings)
		summaries.set(module.file, summary)
		for (const { specifier } of summary.imports.values()) {
			if (!isRelativeSpecifier(specifier)) continue
			const target = resolveModule(module.file, specifier, modules)
			if (target !== undefined) queue.push(target)
		}
	}
	for (const summary of summaries.values()) {
		for (const { name, node } of summary.pendingReferences) {
			const imported = summary.imports.get(name)
			if (imported === undefined) continue
			if (!isRelativeSpecifier(imported.specifier)) {
				const isBuilder = CALL_ROOTS[imported.specifier] !== undefined
				summary.report(
					node,
					'literal',
					isBuilder ? `'${name}' used as a value` : `value imported from the package '${imported.specifier}'`,
					isBuilder ? `${name}.<builder>(…) calls only` : 'a const from a relative module of the application',
				)
				continue
			}
			const target = resolveModule(summary.file, imported.specifier, modules)
			const targetSummary = target === undefined ? undefined : summaries.get(target)
			if (targetSummary === undefined) {
				summary.report(node, 'literal', `unresolved module '${imported.specifier}'`, 'a relative import of a module in the application')
			} else if (!targetSummary.literalConsts.has(imported.imported)) {
				summary.report(
					node,
					'literal',
					`'${imported.imported}' from '${imported.specifier}' is not a literal const`,
					'an import of a const whose value is a literal',
				)
			}
		}
	}
	return findings
}
