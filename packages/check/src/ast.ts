import { parse, type ParserPlugin } from '@babel/parser'

/** An ESTree node as `@babel/parser` returns it with the `estree` plugin, read structurally. */
export interface AstNode {
	readonly type: string
	readonly [key: string]: unknown
}

export interface Position {
	readonly line: number
	readonly column: number
}

export interface Comment {
	readonly text: string
	readonly position: Position
}

export interface ParsedModule {
	readonly file: string
	readonly program: AstNode
	readonly comments: readonly Comment[]
	/** The UTF-8 size of the source text. */
	readonly bytes: number
}

export type ParseResult = { readonly ok: true; readonly module: ParsedModule } | {
	readonly ok: false
	readonly message: string
	readonly position: Position
}

const NON_CHILD_KEYS = new Set(['loc', 'range', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments'])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null

export const isNode = (value: unknown): value is AstNode => isRecord(value) && typeof value['type'] === 'string'

export const child = (node: AstNode, key: string): AstNode | undefined => {
	const value = node[key]
	return isNode(value) ? value : undefined
}

/** The nodes of an array property; holes (`[a, , b]`) come back as `null`. */
export const children = (node: AstNode, key: string): readonly (AstNode | null)[] => {
	const value = node[key]
	return Array.isArray(value) ? value.map((item) => (isNode(item) ? item : null)) : []
}

export const stringField = (node: AstNode, key: string): string | undefined => {
	const value = node[key]
	return typeof value === 'string' ? value : undefined
}

/** The name of an `Identifier`, or `undefined` for any other node. */
export const identifierName = (node: AstNode | undefined): string | undefined => (node?.type === 'Identifier' ? stringField(node, 'name') : undefined)

/** The text of a node whose value is a fixed string: a string `Literal`, or a template with no `${…}`. */
export const staticString = (node: AstNode | undefined): string | undefined => {
	if (node?.type === 'Literal') {
		const value = node['value']
		return typeof value === 'string' ? value : undefined
	}
	if (node?.type !== 'TemplateLiteral' || children(node, 'expressions').length > 0) return undefined
	const quasi = children(node, 'quasis')[0]
	return quasi ? templateText(quasi).cooked : undefined
}

/** A `TemplateElement`'s source text and its decoded value (`undefined` for an invalid escape in a tagged template). */
export const templateText = (element: AstNode): { readonly raw: string; readonly cooked: string | undefined } => {
	const value = element['value']
	if (!isRecord(value)) return { raw: '', cooked: undefined }
	const raw = typeof value['raw'] === 'string' ? value['raw'] : ''
	return { raw, cooked: typeof value['cooked'] === 'string' ? value['cooked'] : undefined }
}

/** A property or member key read statically: `a.b`, `a['b']`, ``a[`b`]``, `{ b: … }`, `{ 'b': … }`. */
export const staticKey = (node: AstNode, keyField: 'property' | 'key'): string | undefined => {
	const key = child(node, keyField)
	if (node['computed'] === true) return staticString(key)
	return identifierName(key) ?? staticString(key)
}

/** The static property names at the end of a member chain, whatever its root: `load().db.sql.raw` → `['db', 'sql', 'raw']`. */
export const memberSuffix = (node: AstNode): readonly string[] => {
	const names: string[] = []
	let current = unwrap(node)
	while (current.type === 'MemberExpression') {
		const name = staticKey(current, 'property')
		const object = child(current, 'object')
		if (name === undefined || object === undefined) break
		names.unshift(name)
		current = unwrap(object)
	}
	return names
}

/** `as const` and `<const>x` fix a literal's type; they assert nothing. */
export const isConstAssertion = (node: AstNode): boolean => {
	const type = child(node, 'typeAnnotation')
	return type?.type === 'TSTypeReference' && identifierName(child(type, 'typeName')) === 'const'
}

/** Strips the wrappers that do not change which value an expression denotes. */
export const unwrap = (node: AstNode): AstNode => {
	let current = node
	while (current.type === 'ChainExpression' || current.type === 'TSNonNullExpression' || current.type === 'ParenthesizedExpression') {
		const inner = child(current, 'expression')
		if (inner === undefined) return current
		current = inner
	}
	return current
}

/** `a.b.c` as `['a', 'b', 'c']`; `undefined` when a link is computed or the root is not an identifier. */
export const memberPath = (node: AstNode): readonly string[] | undefined => {
	const current = unwrap(node)
	const root = identifierName(current)
	if (root !== undefined) return [root]
	if (current.type === 'MetaProperty') return ['import.meta']
	if (current.type !== 'MemberExpression') return undefined
	const object = child(current, 'object')
	const property = staticKey(current, 'property')
	if (object === undefined || property === undefined) return undefined
	const base = memberPath(object)
	return base === undefined ? undefined : [...base, property]
}

const TYPE_POSITION_EXCEPTIONS = new Set([
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
	'TSInstantiationExpression',
])

/** Whether an `Identifier` denotes a runtime value here, rather than a property name, a key, a label or a type. */
export const isValueReference = (node: AstNode, parent: AstNode | undefined): boolean => {
	if (parent === undefined) return true
	const computed = parent['computed'] === true
	switch (parent.type) {
		case 'MemberExpression':
			return parent['object'] === node || computed
		case 'Property':
			return parent['value'] === node || computed || parent['shorthand'] === true
		case 'PropertyDefinition':
		case 'MethodDefinition':
		case 'TSPropertySignature':
			return parent['value'] === node || computed
		case 'ImportSpecifier':
		case 'ImportDefaultSpecifier':
		case 'ImportNamespaceSpecifier':
		case 'ExportSpecifier':
		case 'LabeledStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
		case 'MetaProperty':
			return false
		default:
			return !parent.type.startsWith('TS') || TYPE_POSITION_EXCEPTIONS.has(parent.type)
	}
}

export const positionOf = (node: AstNode): Position => {
	const loc = node['loc']
	if (isRecord(loc)) {
		const start = loc['start']
		if (isRecord(start) && typeof start['line'] === 'number' && typeof start['column'] === 'number') {
			return { line: start['line'], column: start['column'] + 1 }
		}
	}
	return { line: 1, column: 1 }
}

/** Visits every node below `root`, depth first, with the chain of its ancestors (nearest last); `'skip'` prunes a subtree. */
export const walk = (root: AstNode, visit: (node: AstNode, ancestors: readonly AstNode[]) => 'skip' | undefined | void): void => {
	const ancestors: AstNode[] = []
	const enter = (node: AstNode): void => {
		if (visit(node, ancestors) === 'skip') return
		ancestors.push(node)
		for (const [key, value] of Object.entries(node)) {
			if (NON_CHILD_KEYS.has(key)) continue
			if (isNode(value)) enter(value)
			else if (Array.isArray(value)) {
				for (const item of value) if (isNode(item)) enter(item)
			}
		}
		ancestors.pop()
	}
	enter(root)
}

const pluginsFor = (file: string): ParserPlugin[] => {
	if (file.endsWith('.d.ts') || file.endsWith('.d.mts') || file.endsWith('.d.cts')) return [['typescript', { dts: true }], 'estree']
	if (file.endsWith('.tsx')) return ['typescript', 'jsx', 'estree']
	if (file.endsWith('.jsx')) return ['jsx', 'estree']
	if (/\.[mc]?ts$/.test(file)) return ['typescript', 'estree']
	return ['estree']
}

const readComments = (value: unknown): Comment[] => {
	if (!Array.isArray(value)) return []
	const comments: Comment[] = []
	for (const item of value) {
		if (!isNode(item)) continue
		const text = stringField(item, 'value')
		if (text !== undefined) comments.push({ text, position: positionOf(item) })
	}
	return comments
}

const syntaxErrorPosition = (error: unknown): Position => {
	if (isRecord(error)) {
		const loc = error['loc']
		if (isRecord(loc) && typeof loc['line'] === 'number' && typeof loc['column'] === 'number') return { line: loc['line'], column: loc['column'] + 1 }
	}
	return { line: 1, column: 1 }
}

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength

/** The nesting depth of the tree below `root`, measured without recursion, so a deep tree cannot exhaust the stack. */
export const nodeDepth = (root: AstNode): number => {
	let deepest = 0
	const pending: [AstNode, number][] = [[root, 1]]
	for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
		const [node, depth] = entry
		deepest = Math.max(deepest, depth)
		for (const [key, value] of Object.entries(node)) {
			if (NON_CHILD_KEYS.has(key)) continue
			if (isNode(value)) pending.push([value, depth + 1])
			else if (Array.isArray(value)) {
				for (const item of value) if (isNode(item)) pending.push([item, depth + 1])
			}
		}
	}
	return deepest
}

export const parseModule = (file: string, text: string): ParseResult => {
	try {
		const ast = parse(text, { sourceType: 'module', sourceFilename: file, plugins: pluginsFor(file) })
		const program: unknown = ast.program
		if (!isNode(program)) return { ok: false, message: 'the parser returned no program', position: { line: 1, column: 1 } }
		return { ok: true, module: { file, program, comments: readComments(ast.comments), bytes: utf8Bytes(text) } }
	} catch (error) {
		const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : 'unparseable source'
		return { ok: false, message, position: syntaxErrorPosition(error) }
	}
}
