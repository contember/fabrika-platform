// The shell slice of a module: its text without the handlers the staged kit colocates with their endpoints, and
// without what only those handlers use. The static reader, the literal rule, Control's input discovery and the SPA
// bundle read slices, so no module only a handler imports is fetched, parsed or loaded. Runtime-neutral: no Node or
// Bun API.
//
// Removed text becomes spaces, newlines kept, so every finding keeps its line and column. `boot`'s digest check backs
// the slice: it compiles the evaluated modules and refuses to start when they differ from what Control approved.

import {
	type AstNode,
	child,
	children,
	identifierName,
	isNode,
	isValueReference,
	type ParsedModule,
	parseModule,
	type ParseResult,
	walk,
} from './ast'

/** Builders whose result takes `.handle(handler)`: an endpoint of a group, a link or an export, a job and a webhook. */
const HANDLED_BUILDERS = new Set(['query', 'mutation', 'cron', 'webhook'])

interface Range {
	readonly start: number
	readonly end: number
}

const isFunction = (node: AstNode | null | undefined): boolean => node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'

const offsets = (node: AstNode): Range | undefined => {
	const start = node['start']
	const end = node['end']
	return typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined
}

const memberName = (node: AstNode | undefined): string | undefined => {
	if (node?.type !== 'MemberExpression' || node['computed'] === true || node['optional'] === true) return undefined
	return identifierName(child(node, 'property'))
}

/**
 * `<x>.<builder>(…).handle(<inline function>)`: the range of `.handle(…)`, from the end of the builder call. Any other
 * `handle` stays, so the literal rule refuses it with its position.
 */
function handleRange(node: AstNode): Range | undefined {
	if (node.type !== 'CallExpression' || node['optional'] === true) return undefined
	const callee = child(node, 'callee')
	if (memberName(callee) !== 'handle' || callee === undefined) return undefined
	const builderCall = child(callee, 'object')
	if (builderCall?.type !== 'CallExpression' || !HANDLED_BUILDERS.has(memberName(child(builderCall, 'callee')) ?? '')) return undefined
	const handler = children(node, 'arguments')
	if (handler.length !== 1 || !isFunction(handler[0])) return undefined
	const from = offsets(builderCall)
	const to = offsets(node)
	return from === undefined || to === undefined ? undefined : { start: from.end, end: to.end }
}

/** Whether an identifier names a type or a value here, rather than a key, a property or a label. */
function isReference(node: AstNode, parent: AstNode | undefined): boolean {
	switch (parent?.type) {
		case 'TSTypeReference':
			return parent['typeName'] === node
		case 'TSQualifiedName':
			return parent['left'] === node
		case 'TSTypeQuery':
			return parent['exprName'] === node
		case 'TSInterfaceHeritage':
		case 'TSClassImplements':
		case 'TSExpressionWithTypeArguments':
			return parent['expression'] === node
		default:
			return isValueReference(node, parent)
	}
}

interface Binding {
	readonly name: string
	readonly node: AstNode
}

/**
 * The names a top-level statement binds, when the slice may drop it: only what runs nothing when the module loads
 * (an import, a function, a const of an inline function, a type). Every other statement stays, because Bun runs it,
 * and the literal rule decides about it. An exported declaration stays too: it is part of the module.
 */
function removableBindings(statement: AstNode): readonly Binding[] | undefined {
	const bound = (id: AstNode | undefined): Binding[] => {
		const name = identifierName(id)
		return name === undefined || id === undefined ? [] : [{ name, node: id }]
	}
	switch (statement.type) {
		case 'ImportDeclaration': {
			const specifiers = children(statement, 'specifiers').filter(isNode)
			return specifiers.length === 0 ? undefined : specifiers.flatMap((specifier) => bound(child(specifier, 'local')))
		}
		case 'VariableDeclaration': {
			const declarators = children(statement, 'declarations').filter(isNode)
			const functions = declarators.filter((declarator) => isFunction(child(declarator, 'init')))
			return functions.length === declarators.length ? declarators.flatMap((declarator) => bound(child(declarator, 'id'))) : undefined
		}
		case 'FunctionDeclaration':
		case 'TSTypeAliasDeclaration':
		case 'TSInterfaceDeclaration':
			return bound(child(statement, 'id'))
		default:
			return undefined
	}
}

const blank = (text: string): string => text.replace(/[^\n]/g, ' ')

const sliceOf = (text: string, node: AstNode): string => {
	const range = offsets(node)
	return range === undefined ? '' : text.slice(range.start, range.end)
}

/** The import with only its `kept` specifiers, written on its first line, its other lines left empty. */
function rewrittenImport(text: string, statement: AstNode, kept: readonly AstNode[]): string {
	const range = offsets(statement)
	const source = child(statement, 'source')
	if (range === undefined || source === undefined) return text
	const original = text.slice(range.start, range.end)
	const typeOnly = statement['importKind'] === 'type' ? 'type ' : ''
	const named = kept.filter((specifier) => specifier.type === 'ImportSpecifier')
	const leading = kept.filter((specifier) => specifier.type !== 'ImportSpecifier')
	const parts = [
		...leading.map((specifier) => sliceOf(text, specifier)),
		...(named.length > 0 ? [`{ ${named.map((specifier) => sliceOf(text, specifier)).join(', ')} }`] : []),
	]
	const head = `import ${typeOnly}${parts.join(', ')} from ${sliceOf(text, source)}`
	const firstLine = original.indexOf('\n')
	return firstLine === -1 ? head.padEnd(original.length) : `${head}${blank(original.slice(firstLine))}`
}

/** The names `statements` refer to, outside the handlers and outside what is removed. */
function referencedNames(statements: readonly AstNode[], skipped: (node: AstNode) => boolean, own: ReadonlySet<AstNode>): Set<string> {
	const referenced = new Set<string>()
	for (const statement of statements) {
		walk(statement, (node, ancestors) => {
			if (skipped(node)) return 'skip'
			const name = identifierName(node)
			if (name !== undefined && !own.has(node) && isReference(node, ancestors.at(-1))) referenced.add(name)
			return undefined
		})
	}
	return referenced
}

/**
 * The slice of one parsed module: `module`'s text with every `.handle(…)` and everything only the handlers used
 * blanked. A module without a handler comes back unchanged.
 */
export function moduleSlice(module: ParsedModule, text: string): string {
	const handles: Range[] = []
	walk(module.program, (node) => {
		const range = handleRange(node)
		if (range === undefined) return undefined
		handles.push(range)
		return 'skip'
	})
	if (handles.length === 0) return text
	const inHandle = (node: AstNode): boolean => {
		const range = offsets(node)
		return range !== undefined && handles.some((handle) => range.start >= handle.start && range.end <= handle.end)
	}
	const statements = children(module.program, 'body').filter(isNode)
	const removable = new Map<AstNode, readonly Binding[]>()
	for (const statement of statements) {
		const bindings = removableBindings(statement)
		if (bindings !== undefined) removable.set(statement, bindings)
	}
	const own = new Set([...removable.values()].flatMap((bindings) => bindings.map((binding) => binding.node)))
	// What the module uses with its handlers: a declaration nobody uses at all is not the handlers', so it stays.
	const used = referencedNames(statements, () => false, own)
	const removedStatements = new Set<AstNode>()
	const removedSpecifiers = new Set<AstNode>()
	for (let changed = true; changed;) {
		changed = false
		const kept = statements.filter((statement) => !removedStatements.has(statement))
		const referenced = referencedNames(kept, (node) => inHandle(node) || removedSpecifiers.has(node), own)
		const handlersOnly = (name: string): boolean => used.has(name) && !referenced.has(name)
		for (const [statement, bindings] of removable) {
			if (removedStatements.has(statement)) continue
			if (statement.type === 'ImportDeclaration') {
				const specifiers = children(statement, 'specifiers').filter(isNode)
				for (const specifier of specifiers) {
					const name = identifierName(child(specifier, 'local'))
					if (name !== undefined && !removedSpecifiers.has(specifier) && handlersOnly(name)) {
						removedSpecifiers.add(specifier)
						changed = true
					}
				}
				if (specifiers.every((specifier) => removedSpecifiers.has(specifier))) removedStatements.add(statement)
			} else if (bindings.every((binding) => handlersOnly(binding.name))) {
				removedStatements.add(statement)
				changed = true
			}
		}
	}
	const removedRanges = [...removedStatements].flatMap((statement) => offsets(statement) ?? [])
	const edits: { readonly range: Range; readonly replacement: string }[] = handles
		.filter((handle) => !removedRanges.some((range) => handle.start >= range.start && handle.end <= range.end))
		.map((range) => ({ range, replacement: blank(text.slice(range.start, range.end)) }))
	for (const statement of statements) {
		const range = offsets(statement)
		if (range === undefined) continue
		if (removedStatements.has(statement)) {
			edits.push({ range, replacement: blank(text.slice(range.start, range.end)) })
			continue
		}
		const specifiers = statement.type === 'ImportDeclaration' ? children(statement, 'specifiers').filter(isNode) : []
		if (specifiers.some((specifier) => removedSpecifiers.has(specifier))) {
			edits.push({ range, replacement: rewrittenImport(text, statement, specifiers.filter((specifier) => !removedSpecifiers.has(specifier))) })
		}
	}
	let sliced = text
	for (const edit of edits.sort((left, right) => right.range.start - left.range.start)) {
		sliced = sliced.slice(0, edit.range.start) + edit.replacement + sliced.slice(edit.range.end)
	}
	return sliced
}

/**
 * The slice of a module's text. Text that does not parse comes back unchanged, so the reader reports the parse error
 * where it is.
 */
export function shellSlice(file: string, text: string): string {
	const parsed = parseModule(file, text)
	return parsed.ok ? moduleSlice(parsed.module, text) : text
}

/** A module parsed as its slice: what the reader, the literal rule and input discovery read. */
export function parseShellModule(file: string, text: string): ParseResult {
	const parsed = parseModule(file, text)
	if (!parsed.ok) return parsed
	const sliced = moduleSlice(parsed.module, text)
	return sliced === text ? parsed : parseModule(file, sliced)
}
