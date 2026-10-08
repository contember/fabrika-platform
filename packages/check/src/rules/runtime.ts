import { type AstNode, child, children, identifierName, isValueReference, memberPath, staticKey, stringField, stringLiteral, unwrap } from '../ast'
import type { Report } from '../finding'
import { FORBIDDEN_BUN_ALLOWED, FORBIDDEN_BUN_MEMBERS } from './modules'

export interface SourceContext {
	readonly report: Report
	/** The generated entrypoint is the one module that reads the framework's variables. */
	readonly isGeneratedEntry: boolean
}

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self'])
/** Kysely's raw helpers (`sql.raw`, `sql.lit`, …) and Bun's `sql.unsafe`. */
const RAW_SQL_HELPERS = new Set(['raw', 'lit', 'ref', 'id', 'table', 'val', 'join', 'unsafe'])

/** `globalThis.Bun.serve` and `Bun.serve` name the same global. */
const globalPath = (node: AstNode): readonly string[] | undefined => {
	const path = memberPath(node)
	if (path === undefined) return undefined
	let start = 0
	while (start < path.length - 1 && GLOBAL_OBJECTS.has(path[start] ?? '')) start++
	return path.slice(start)
}

const pathIs = (path: readonly string[] | undefined, ...expected: string[]): boolean =>
	path !== undefined && path.length === expected.length && expected.every((segment, index) => path[index] === segment)

const firstArgument = (node: AstNode): AstNode | undefined => {
	const first = children(node, 'arguments')[0]
	return first === null || first === undefined ? undefined : unwrap(first)
}

/** The text a string or template literal starts with, as far as it is static. */
const staticPrefix = (node: AstNode | undefined): string | undefined => {
	if (node === undefined) return undefined
	const literal = stringLiteral(node)
	if (literal !== undefined) return literal
	if (node.type === 'TemplateLiteral') {
		const head = children(node, 'quasis')[0]
		const value = head ? head['value'] : undefined
		return typeof value === 'object' && value !== null && 'cooked' in value && typeof value.cooked === 'string' ? value.cooked : undefined
	}
	if (node.type === 'NewExpression' && ['URL', 'Request'].includes(identifierName(child(node, 'callee')) ?? '')) {
		return staticPrefix(firstArgument(node))
	}
	return undefined
}

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const LOCAL_SCHEMES = /^(?:data|blob):/i

const checkFetch = (node: AstNode, path: readonly string[] | undefined, context: SourceContext): void => {
	if (!pathIs(path, 'fetch')) return
	const target = staticPrefix(firstArgument(node))
	if (target === undefined || !ABSOLUTE_URL.test(target) || LOCAL_SCHEMES.test(target)) return
	context.report(
		node,
		'cross-app-fetch',
		`fetch to the absolute origin '${target}' is a hand-written integration`,
		'a same-origin path to a declared endpoint, or another application through a connector import',
	)
}

const checkDynamicCode = (node: AstNode, path: readonly string[] | undefined, context: SourceContext): void => {
	const isFunctionConstructor = pathIs(path, 'Function') && (node.type === 'CallExpression' || node.type === 'NewExpression')
	if (isFunctionConstructor) {
		context.report(node, 'dynamic-code', 'the Function constructor compiles a string into code', 'a function written in the source')
		return
	}
	if (node.type !== 'CallExpression' || !(pathIs(path, 'setTimeout') || pathIs(path, 'setInterval'))) return
	const callback = firstArgument(node)
	if (callback !== undefined && staticPrefix(callback) !== undefined && callback.type !== 'NewExpression') {
		context.report(node, 'dynamic-code', `${path?.[0]} with a string evaluates it as code`, 'a function callback')
	}
}

const SENSITIVE_NAMES = new Set(['err', 'error', 'e', 'ex', 'exception', 'cause', 'req', 'request', 'headers', 'env'])
const SENSITIVE_MEMBERS = new Set(['error', 'cause', 'request', 'headers', 'env'])

const catchParameters = (ancestors: readonly AstNode[]): ReadonlySet<string> => {
	const names = new Set<string>()
	for (const ancestor of ancestors) {
		if (ancestor.type !== 'CatchClause') continue
		const name = identifierName(child(ancestor, 'param'))
		if (name !== undefined) names.add(name)
	}
	return names
}

/** The first argument part that logs an error object, a request, headers or the environment. */
const sensitiveArgument = (node: AstNode, caught: ReadonlySet<string>): AstNode | undefined => {
	const value = unwrap(node)
	const name = identifierName(value)
	if (name !== undefined) return SENSITIVE_NAMES.has(name) || caught.has(name) ? value : undefined
	if (value.type === 'MemberExpression') {
		const property = staticKey(value, 'property')
		return property !== undefined && SENSITIVE_MEMBERS.has(property) ? value : undefined
	}
	const nested: AstNode[] = []
	if (value.type === 'ObjectExpression') {
		for (const property of children(value, 'properties')) {
			const inner = property && (property.type === 'SpreadElement' ? child(property, 'argument') : child(property, 'value'))
			if (inner) nested.push(inner)
		}
	} else if (value.type === 'ArrayExpression' || value.type === 'CallExpression' || value.type === 'NewExpression') {
		const key = value.type === 'ArrayExpression' ? 'elements' : 'arguments'
		for (const element of children(value, key)) if (element) nested.push(element)
	} else if (value.type === 'SpreadElement') {
		const argument = child(value, 'argument')
		if (argument) nested.push(argument)
	}
	for (const inner of nested) {
		const found = sensitiveArgument(inner, caught)
		if (found !== undefined) return found
	}
	return undefined
}

const checkConsole = (node: AstNode, path: readonly string[] | undefined, ancestors: readonly AstNode[], context: SourceContext): void => {
	if (path === undefined || path.length !== 2 || path[0] !== 'console') return
	const caught = catchParameters(ancestors)
	for (const argument of children(node, 'arguments')) {
		if (argument === null) continue
		const found = sensitiveArgument(argument, caught)
		if (found === undefined) continue
		context.report(
			found,
			'sensitive-log',
			`console.${path[1]} of an error object, request, headers or environment can carry a secret`,
			'a short message, or a chosen field such as error.message',
		)
		return
	}
}

const PROTOTYPE_KEYS = new Set(['prototype', '__proto__'])
const PROTOTYPE_WRITERS = ['Object.setPrototypeOf', 'Reflect.setPrototypeOf']
const PROPERTY_WRITERS = ['Object.defineProperty', 'Object.defineProperties', 'Object.assign', 'Reflect.defineProperty', 'Reflect.set']

/** Whether a member chain passes through `.prototype` or `.__proto__`, computed links included. */
const touchesPrototype = (node: AstNode | undefined): boolean => {
	let current = node === undefined ? undefined : unwrap(node)
	while (current?.type === 'MemberExpression') {
		const key = staticKey(current, 'property')
		if (key !== undefined && PROTOTYPE_KEYS.has(key)) return true
		const object = child(current, 'object')
		current = object === undefined ? undefined : unwrap(object)
	}
	return false
}

const PROTOTYPE_ALLOWED = 'no patching of prototypes; the framework checks capabilities at runtime'

const checkPrototypeCall = (node: AstNode, path: readonly string[] | undefined, context: SourceContext): void => {
	const name = path?.join('.') ?? ''
	if (PROTOTYPE_WRITERS.includes(name)) {
		context.report(node, 'prototype-assignment', `${name} replaces an object's prototype`, PROTOTYPE_ALLOWED)
	} else if (PROPERTY_WRITERS.includes(name) && touchesPrototype(firstArgument(node))) {
		context.report(node, 'prototype-assignment', `${name} writes to a prototype`, PROTOTYPE_ALLOWED)
	}
}

const checkCall = (node: AstNode, ancestors: readonly AstNode[], context: SourceContext): void => {
	const callee = child(node, 'callee')
	const path = callee === undefined ? undefined : globalPath(callee)
	checkDynamicCode(node, path, context)
	if (node.type !== 'CallExpression') return
	checkFetch(node, path, context)
	checkConsole(node, path, ancestors, context)
	checkPrototypeCall(node, path, context)
	if (pathIs(path, 'sql')) context.report(node, 'raw-sql', 'sql(…) builds raw SQL', 'a query through the scoped data layer of @fabrika/db')
}

const checkMember = (node: AstNode, parent: AstNode | undefined, context: SourceContext): void => {
	const path = globalPath(node)
	const property = staticKey(node, 'property')
	if (path?.length === 2 && path[0] === 'Bun' && FORBIDDEN_BUN_MEMBERS.has(path[1] ?? '')) {
		context.report(node, 'forbidden-global', `Bun.${path[1]} bypasses the framework`, FORBIDDEN_BUN_ALLOWED)
	}
	if (!context.isGeneratedEntry && (pathIs(path, 'process', 'env') || pathIs(path, 'Bun', 'env'))) {
		context.report(
			node,
			'env-read',
			`${path?.join('.')} is read outside the generated entrypoint`,
			'values the framework hands the handler through deps or ctx',
		)
	}
	if (!context.isGeneratedEntry && pathIs(path, 'import.meta', 'env')) {
		const name = parent?.type === 'MemberExpression' && parent['object'] === node ? staticKey(parent, 'property') : undefined
		if (name === undefined || !name.startsWith('FABRIKA_PUBLIC_')) {
			context.report(
				node,
				'public-env',
				`import.meta.env${name === undefined ? '' : `.${name}`} is not a public variable`,
				'import.meta.env.FABRIKA_PUBLIC_<NAME>',
			)
		}
	}
	if (path?.length === 2 && path[0] === 'sql' && RAW_SQL_HELPERS.has(path[1] ?? '')) {
		context.report(node, 'raw-sql', `sql.${path[1]} builds raw SQL`, 'a query through the scoped data layer of @fabrika/db')
	}
	if (property === 'innerHTML' || property === 'outerHTML' || property === 'insertAdjacentHTML') {
		context.report(node, 'unsafe-html', `${property} injects markup that runs as the signed-in user`, 'text content, or elements rendered by React')
	}
}

const checkIdentifier = (node: AstNode, parent: AstNode | undefined, context: SourceContext): void => {
	if (!isValueReference(node, parent)) return
	const name = stringField(node, 'name')
	const isMemberObject = parent?.type === 'MemberExpression' && parent['object'] === node
	if (name === 'eval') context.report(node, 'dynamic-code', 'eval runs a string as code', 'a function written in the source')
	if (name === 'Bun' && !isMemberObject) {
		context.report(node, 'forbidden-global', 'Bun used as a value hides which global is reached', 'Bun.<member> written out')
	}
	if (name === 'process' && !isMemberObject && !context.isGeneratedEntry && !(parent?.type === 'UnaryExpression' && parent['operator'] === 'typeof')) {
		context.report(
			node,
			'env-read',
			'process used as a value hides a read of process.env',
			'values the framework hands the handler through deps or ctx',
		)
	}
}

/** `const { env } = import.meta` reads the whole environment without naming a variable. */
const checkDestructuredEnv = (node: AstNode, context: SourceContext): void => {
	const pattern = child(node, 'id')
	const init = child(node, 'init')
	if (pattern?.type !== 'ObjectPattern' || init?.type !== 'MetaProperty' || context.isGeneratedEntry) return
	if (children(pattern, 'properties').some((property) => property !== null && staticKey(property, 'key') === 'env')) {
		context.report(node, 'public-env', 'env destructured from import.meta', 'import.meta.env.FABRIKA_PUBLIC_<NAME>')
	}
}

const checkAssignment = (node: AstNode, context: SourceContext): void => {
	const target = child(node, node.type === 'UpdateExpression' ? 'argument' : 'left')
	if (target !== undefined && touchesPrototype(target)) {
		context.report(node, 'prototype-assignment', 'assignment to a prototype patches every instance', PROTOTYPE_ALLOWED)
	}
}

const KEY_PREFIX = 'px_'

const checkStringContent = (node: AstNode, text: string | undefined, context: SourceContext): void => {
	if (text?.includes(KEY_PREFIX)) {
		context.report(
			node,
			'key-literal',
			`'${KEY_PREFIX}' in a literal: a key or a session cookie name in source`,
			'the credential the framework supplies; keys never appear in code',
		)
	}
}

const templateText = (node: AstNode): string | undefined => {
	const value = node['value']
	return typeof value === 'object' && value !== null && 'raw' in value && typeof value.raw === 'string' ? value.raw : undefined
}

const isTypeOnlyImport = (specifier: AstNode, parent: AstNode | undefined): boolean =>
	stringField(specifier, 'importKind') === 'type' || (parent !== undefined && stringField(parent, 'importKind') === 'type')

/** The rules that read one node at a time, for every source file. */
export const checkRuntimeNode = (node: AstNode, ancestors: readonly AstNode[], context: SourceContext): void => {
	const parent = ancestors[ancestors.length - 1]
	switch (node.type) {
		case 'CallExpression':
		case 'NewExpression':
			return checkCall(node, ancestors, context)
		case 'MemberExpression':
			return checkMember(node, parent, context)
		case 'Identifier':
			return checkIdentifier(node, parent, context)
		case 'VariableDeclarator':
			return checkDestructuredEnv(node, context)
		case 'AssignmentExpression':
		case 'UpdateExpression':
			return checkAssignment(node, context)
		case 'TaggedTemplateExpression': {
			const tag = child(node, 'tag')
			const path = tag === undefined ? undefined : memberPath(tag)
			if (path !== undefined && path[path.length - 1] === 'sql') {
				context.report(node, 'raw-sql', 'an sql`…` template is raw SQL', 'a query through the scoped data layer of @fabrika/db')
			}
			return
		}
		case 'ImportSpecifier': {
			const imported = child(node, 'imported')
			if ((identifierName(imported) ?? stringLiteral(imported)) === 'sql' && !isTypeOnlyImport(node, parent)) {
				context.report(node, 'raw-sql', `the sql tag imported`, 'a query through the scoped data layer of @fabrika/db')
			}
			return
		}
		case 'Literal':
			return checkStringContent(node, stringLiteral(node), context)
		case 'TemplateElement':
			return checkStringContent(node, templateText(node), context)
		case 'JSXAttribute': {
			const name = child(node, 'name')
			if (name?.type === 'JSXIdentifier' && stringField(name, 'name') === 'dangerouslySetInnerHTML') {
				context.report(
					node,
					'unsafe-html',
					'dangerouslySetInnerHTML injects markup that runs as the signed-in user',
					'text content, or elements rendered by React',
				)
			}
			return
		}
		case 'Property':
			if (staticKey(node, 'key') === 'dangerouslySetInnerHTML') {
				context.report(
					node,
					'unsafe-html',
					'dangerouslySetInnerHTML injects markup that runs as the signed-in user',
					'text content, or elements rendered by React',
				)
			}
			return
	}
}
