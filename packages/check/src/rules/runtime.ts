import {
	type AstNode,
	child,
	children,
	identifierName,
	isValueReference,
	memberPath,
	memberSuffix,
	staticKey,
	staticString,
	stringField,
	templateText,
	unwrap,
	walk,
} from '../ast'
import type { Report } from '../finding'
import { unwrapValue } from '../graph'
import { isRequire } from '../references'
import { declaringScope } from '../scope'
import { FORBIDDEN_BUN_MEMBERS } from './modules'
import { handledProcedure } from './structure'

export interface SourceContext {
	readonly report: Report
	/** The generated entrypoint is the one module that reads the framework's variables. */
	readonly isGeneratedEntry: boolean
	/** The names the module binds to an imported `sql` (`rawSqlBindings`): a parameter of that name is not one of them. */
	readonly rawSql: ReadonlySet<string>
	/** A module under `src/` that is not a test: it reaches no global object and no `Bun` at all. */
	readonly isServerModule: boolean
	/** A `fetch` of an absolute URL: refused once the contract shows that no site declares its origin in `egress`. */
	readonly absoluteFetch: (node: AstNode, target: string) => void
	/** A `ctx.url('<endpoint id>', …)` with a literal id: refused once the contract shows that it names no procedure. */
	readonly appUrl: (node: AstNode, endpoint: string) => void
	/** A `<table>.insert(values, { onConflict: { columns } })`: refused once the migrations show no unique index of them. */
	readonly conflictInsert: (node: AstNode, table: string, columns: readonly string[]) => void
}

/**
 * The global objects, `Bun`, and `WebSocket`, a socket the egress guard on `fetch` does not see: a server module reaches
 * the platform and the outside through the framework only.
 */
const SERVER_REFUSED_GLOBALS = new Set(['globalThis', 'global', 'self', 'window', 'Bun', 'WebSocket'])

/**
 * The local names a module binds to a value named `sql` it loads: `import { sql as q } from 'kysely'` and
 * `const { sql } = await import('bun')`. The raw-sql rule refuses a driver's tag by this origin, so a query function
 * may take the declared `ctx.sql` tag as a parameter of any name.
 */
export const rawSqlBindings = (program: AstNode): ReadonlySet<string> => {
	const names = new Set<string>()
	walk(program, (node) => {
		if (node.type === 'ImportDeclaration' && stringField(node, 'importKind') !== 'type') {
			for (const item of children(node, 'specifiers')) {
				const imported = item === null ? undefined : child(item, 'imported')
				const local = item === null || stringField(item, 'importKind') === 'type' ? undefined : identifierName(child(item, 'local'))
				if (local !== undefined && (identifierName(imported) ?? staticString(imported)) === 'sql') names.add(local)
			}
		} else if (node.type === 'VariableDeclarator' && isLoad(child(node, 'init'))) {
			const pattern = child(node, 'id')
			for (const property of pattern?.type === 'ObjectPattern' ? children(pattern, 'properties') : []) {
				const local = property?.type === 'Property' && staticKey(property, 'key') === 'sql' ? identifierName(child(property, 'value')) : undefined
				if (local !== undefined) names.add(local)
			}
		}
	})
	return names
}

/** `import(x)`, `await import(x)` or `require(x)`. */
const isLoad = (init: AstNode | undefined): boolean => {
	const value = init === undefined ? undefined : unwrap(init)
	const load = value?.type === 'AwaitExpression' ? child(value, 'argument') : value
	return load !== undefined && loadedSpecifier(load) !== undefined
}

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self'])
/** Kysely's raw helpers (`sql.raw`, `sql.lit`, …) and Bun's `sql.unsafe`. */
const RAW_SQL_HELPERS = new Set(['raw', 'lit', 'ref', 'id', 'table', 'val', 'join', 'unsafe'])
const ALLOWED_ENV = 'values the framework hands the handler through deps or ctx'
const ALLOWED_QUERY = 'a query through the scoped data layer of @fabrika/db'
const ALLOWED_MARKUP = 'text content, or elements rendered by React'
const ALLOWED_CODE = 'a function written in the source'

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

const argumentAt = (node: AstNode, position: number): AstNode | undefined => {
	const argument = children(node, 'arguments')[position]
	return argument === null || argument === undefined ? undefined : unwrap(argument)
}

/** The argument a direct call receives, also through `f.call(this, x)` and `f.apply(this, [x])`. */
const invokedArgument = (node: AstNode, path: readonly string[], name: string): AstNode | undefined => {
	if (pathIs(path, name)) return argumentAt(node, 0)
	if (pathIs(path, name, 'call')) return argumentAt(node, 1)
	const list = pathIs(path, name, 'apply') ? argumentAt(node, 1) : undefined
	const first = list?.type === 'ArrayExpression' ? children(list, 'elements')[0] : undefined
	return first === null || first === undefined ? undefined : unwrap(first)
}

/** The text a string expression starts with, as far as it is static: literals, templates and `+` concatenation. */
const staticPrefix = (node: AstNode | undefined): string | undefined => {
	if (node === undefined) return undefined
	const whole = staticString(node)
	if (whole !== undefined) return whole
	if (node.type === 'TemplateLiteral') {
		const head = children(node, 'quasis')[0]
		return head ? templateText(head).cooked : undefined
	}
	if (node.type === 'BinaryExpression' && node['operator'] === '+') {
		const left = child(node, 'left')
		const leftText = left === undefined ? undefined : staticString(unwrap(left))
		const right = child(node, 'right')
		if (leftText !== undefined) return leftText + (staticPrefix(right === undefined ? undefined : unwrap(right)) ?? '')
		return staticPrefix(left === undefined ? undefined : unwrap(left))
	}
	if (node.type === 'NewExpression' && ['URL', 'Request'].includes(identifierName(child(node, 'callee')) ?? '')) {
		return staticPrefix(argumentAt(node, 0))
	}
	return undefined
}

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const LOCAL_SCHEMES = /^(?:data|blob):/i

const checkFetch = (node: AstNode, path: readonly string[], context: SourceContext): void => {
	const target = staticPrefix(invokedArgument(node, path, 'fetch'))
	if (target === undefined || !ABSOLUTE_URL.test(target) || LOCAL_SCHEMES.test(target)) return
	context.absoluteFetch(node, target)
}

/** `ctx.url('<endpoint id>', …)`, also on a `ctx` reached through a member (`args.ctx.url`). */
const checkAppUrl = (node: AstNode, context: SourceContext): void => {
	const callee = child(node, 'callee')
	const path = callee === undefined ? undefined : memberPath(callee)
	if (path === undefined || path.length < 2 || path[path.length - 1] !== 'url' || path[path.length - 2] !== 'ctx') return
	const endpoint = staticString(argumentAt(node, 0))
	if (endpoint !== undefined) context.appUrl(node, endpoint)
}

/**
 * `<…>.<table>.insert(values, { onConflict: { columns: ['a', 'b'] } })` with literal columns: the receiver's last name
 * is the table, as `ctx.db.<…>.<table>` names it. Anything else (an alias, computed columns) is the runtime's to refuse.
 */
const checkConflictInsert = (node: AstNode, context: SourceContext): void => {
	const callee = child(node, 'callee')
	const path = callee === undefined ? undefined : memberSuffix(callee)
	const table = path !== undefined && path.length >= 2 && path[path.length - 1] === 'insert' ? path[path.length - 2] : undefined
	const options = argumentAt(node, 1)
	if (table === undefined || options?.type !== 'ObjectExpression') return
	const onConflict = propertyValue(options, 'onConflict')
	const columns = onConflict?.type === 'ObjectExpression' ? propertyValue(onConflict, 'columns') : undefined
	if (columns?.type !== 'ArrayExpression') return
	const names = children(columns, 'elements').map((element) => (element === null ? undefined : staticString(unwrap(element))))
	const literal = names.filter((name): name is string => name !== undefined)
	if (literal.length > 0 && literal.length === names.length) context.conflictInsert(node, table, literal)
}

/** The value of an object literal's property `name`, written with a static key. */
const propertyValue = (object: AstNode, name: string): AstNode | undefined => {
	for (const property of children(object, 'properties')) {
		if (property?.type === 'Property' && staticKey(property, 'key') === name) {
			const value = child(property, 'value')
			return value === undefined ? undefined : unwrap(value)
		}
	}
	return undefined
}

/** The finding of a `fetch` of an absolute URL whose origin no site of the contract declares. */
export const crossAppFetchMessage = (target: string): { readonly message: string; readonly allowed: string } => ({
	message: `fetch to the absolute origin '${target}' is a hand-written integration`,
	allowed:
		"a same-origin path to a declared endpoint, another application through a connector import, egress: ['<origin>'] on the site, or a public host of http(s) under a cron job's egress: 'public'",
})

const checkDynamicCode = (node: AstNode, path: readonly string[], context: SourceContext): void => {
	const isConstructor = pathIs(path, 'Function') || pathIs(path, 'Function', 'call') || pathIs(path, 'Function', 'apply')
	if (isConstructor && (node.type === 'CallExpression' || node.type === 'NewExpression')) {
		context.report(node, 'dynamic-code', 'the Function constructor compiles a string into code', ALLOWED_CODE)
		return
	}
	if (node.type !== 'CallExpression' || !(pathIs(path, 'setTimeout') || pathIs(path, 'setInterval'))) return
	const callback = argumentAt(node, 0)
	if (callback !== undefined && callback.type !== 'NewExpression' && staticPrefix(callback) !== undefined) {
		context.report(node, 'dynamic-code', `${path[0]} with a string evaluates it as code`, 'a function callback')
	}
}

const SENSITIVE_NAMES = new Set(['err', 'error', 'e', 'ex', 'exception', 'cause', 'req', 'request', 'headers', 'env'])
const SENSITIVE_MEMBERS = new Set(['error', 'cause', 'request', 'headers', 'env'])
const SENSITIVE_CONSTRUCTORS = /^(?:\w*Error|Request|Headers)$/

const catchParameters = (ancestors: readonly AstNode[]): ReadonlySet<string> => {
	const names = new Set<string>()
	for (const ancestor of ancestors) {
		const name = ancestor.type === 'CatchClause' ? identifierName(child(ancestor, 'param')) : undefined
		if (name !== undefined) names.add(name)
	}
	return names
}

/** The parts of an expression whose value is logged as is: a conditional's branches, a template's substitutions, … */
const loggedParts = (value: AstNode): readonly AstNode[] => {
	const parts = (key: string) => children(value, key).filter((item): item is AstNode => item !== null)
	const single = (key: string) => {
		const inner = child(value, key)
		return inner === undefined ? [] : [inner]
	}
	switch (value.type) {
		case 'ObjectExpression':
			return parts('properties').flatMap((property) => {
				const inner = child(property, property.type === 'SpreadElement' ? 'argument' : 'value')
				return inner === undefined ? [] : [inner]
			})
		case 'ArrayExpression':
			return parts('elements')
		case 'CallExpression':
		case 'NewExpression':
			return parts('arguments')
		case 'TemplateLiteral':
			return parts('expressions')
		case 'ConditionalExpression':
			return [...single('consequent'), ...single('alternate')]
		case 'LogicalExpression':
			return [...single('left'), ...single('right')]
		case 'SpreadElement':
		case 'AwaitExpression':
			return single('argument')
		default:
			return []
	}
}

/** The first part of a logged value that is an error object, a request, headers or the environment. */
const sensitiveArgument = (node: AstNode, caught: ReadonlySet<string>): AstNode | undefined => {
	const value = unwrap(node)
	const name = identifierName(value)
	if (name !== undefined) return SENSITIVE_NAMES.has(name) || caught.has(name) ? value : undefined
	if (value.type === 'MemberExpression') {
		const property = staticKey(value, 'property')
		return property !== undefined && SENSITIVE_MEMBERS.has(property) ? value : undefined
	}
	if (value.type === 'NewExpression' && SENSITIVE_CONSTRUCTORS.test(identifierName(child(value, 'callee')) ?? '')) return value
	for (const part of loggedParts(value)) {
		const found = sensitiveArgument(part, caught)
		if (found !== undefined) return found
	}
	return undefined
}

const checkConsole = (node: AstNode, path: readonly string[], ancestors: readonly AstNode[], context: SourceContext): void => {
	if (path.length !== 2 || path[0] !== 'console') return
	const caught = catchParameters(ancestors)
	for (const argument of children(node, 'arguments')) {
		const found = argument === null ? undefined : sensitiveArgument(argument, caught)
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
const PROTOTYPE_READERS = ['Object.getPrototypeOf', 'Reflect.getPrototypeOf']
const PROTOTYPE_WRITERS = ['Object.setPrototypeOf', 'Reflect.setPrototypeOf']
const PROPERTY_WRITERS = ['Object.defineProperty', 'Object.defineProperties', 'Object.assign', 'Reflect.defineProperty', 'Reflect.set']
const ALLOWED_PROTOTYPE = 'no patching of prototypes; the framework checks capabilities at runtime'

/** Whether an expression reaches a prototype: through `.prototype`, `.__proto__` or `Object.getPrototypeOf(…)`. */
export const touchesPrototype = (node: AstNode | undefined): boolean => {
	let current = node === undefined ? undefined : unwrap(node)
	while (current?.type === 'MemberExpression') {
		const key = staticKey(current, 'property')
		if (key !== undefined && PROTOTYPE_KEYS.has(key)) return true
		const object = child(current, 'object')
		current = object === undefined ? undefined : unwrap(object)
	}
	const callee = current?.type === 'CallExpression' ? child(current, 'callee') : undefined
	return callee !== undefined && PROTOTYPE_READERS.includes(memberPath(callee)?.join('.') ?? '')
}

const checkPrototypeCall = (node: AstNode, path: readonly string[], context: SourceContext): void => {
	const name = path.join('.')
	if (PROTOTYPE_WRITERS.includes(name)) {
		context.report(node, 'prototype-assignment', `${name} replaces an object's prototype`, ALLOWED_PROTOTYPE)
	} else if (PROPERTY_WRITERS.includes(name) && touchesPrototype(argumentAt(node, 0))) {
		context.report(node, 'prototype-assignment', `${name} writes to a prototype`, ALLOWED_PROTOTYPE)
	}
}

const ALLOWED_LOAD = 'a static import, or import() and require() of a string literal'

/** The specifier of a direct load: `import(x)`, `require(x)`, `module.require(x)`, `import.meta.require(x)`. */
const loadedSpecifier = (node: AstNode): { readonly what: string; readonly specifier: AstNode | null | undefined } | undefined => {
	if (node.type === 'ImportExpression') return { what: 'import()', specifier: child(node, 'source') }
	if (node.type === 'CallExpression' && isRequire(child(node, 'callee'))) return { what: 'require()', specifier: children(node, 'arguments')[0] }
	return undefined
}

/** A load of a computed specifier: the checker cannot say which module it reaches, nor run its rules there. */
const checkComputedLoad = (node: AstNode, context: SourceContext): void => {
	const load = loadedSpecifier(node)
	if (load === undefined || staticString(load.specifier ?? undefined) !== undefined) return
	context.report(node, 'unchecked-import', `${load.what} of a computed specifier loads a module the checker cannot name`, ALLOWED_LOAD)
}

const LOADER_METHODS = new Set(['call', 'apply', 'bind'])

/** A loader invoked indirectly, `require.call(…)` or `Reflect.apply(require, …)`: references.ts reads direct calls only. */
const checkIndirectLoad = (node: AstNode, path: readonly string[] | undefined, context: SourceContext): void => {
	const callee = child(node, 'callee')
	const object = callee?.type === 'MemberExpression' ? child(callee, 'object') : undefined
	const method = callee?.type === 'MemberExpression' ? staticKey(callee, 'property') : undefined
	const loader = method !== undefined && LOADER_METHODS.has(method) && isRequire(object) ? object : undefined
	const applied = pathIs(path, 'Reflect', 'apply') && isRequire(argumentAt(node, 0)) ? argumentAt(node, 0) : undefined
	const reached = loader ?? applied
	if (reached === undefined) return
	const name = `${memberPath(reached)?.join('.') ?? 'require'}${loader === undefined ? ' through Reflect.apply' : `.${method}`}`
	context.report(node, 'unchecked-import', `${name} loads a module the checker does not follow`, ALLOWED_LOAD)
}

/** They turn a specifier into a module file, or reach the loaded modules: what a load by path or URL starts from. */
const RESOLVERS = new Set(['import.meta.resolve', 'import.meta.resolveSync', 'require.resolve', 'require.cache', 'Bun.resolve', 'Bun.resolveSync'])

const checkCall = (node: AstNode, ancestors: readonly AstNode[], context: SourceContext): void => {
	checkComputedLoad(node, context)
	const callee = child(node, 'callee')
	const path = callee === undefined ? undefined : globalPath(callee)
	if (node.type === 'CallExpression') checkIndirectLoad(node, path, context)
	// A data-layer handle is reached through calls (`ctx.db.app('…')`), so its insert has no global path.
	if (node.type === 'CallExpression') checkConflictInsert(node, context)
	if (path === undefined) return
	checkDynamicCode(node, path, context)
	if (node.type !== 'CallExpression') return
	checkFetch(node, path, context)
	checkAppUrl(node, context)
	checkConsole(node, path, ancestors, context)
	checkPrototypeCall(node, path, context)
	const [name] = path
	if (path.length === 1 && name !== undefined && context.rawSql.has(name)) {
		context.report(node, 'raw-sql', `${name}(…) builds raw SQL`, ALLOWED_QUERY)
	}
}

const checkMember = (node: AstNode, ancestors: readonly AstNode[], context: SourceContext): void => {
	const parent = ancestors[ancestors.length - 1]
	const path = globalPath(node)
	const property = staticKey(node, 'property')
	const name = path?.join('.') ?? ''
	if (RESOLVERS.has(name)) context.report(node, 'unchecked-import', `${name} names a module by its file, past what the checker reads`, ALLOWED_LOAD)
	if (name === 'process.getBuiltinModule') {
		context.report(
			node,
			'unchecked-import',
			'process.getBuiltinModule loads a built-in module past the import rules (createRequire among them)',
			ALLOWED_LOAD,
		)
	}
	const bunMember = path?.length === 2 && path[0] === 'Bun' ? FORBIDDEN_BUN_MEMBERS.get(path[1] ?? '') : undefined
	// In a server module the root itself is refused (`checkIdentifier`), once.
	const root = memberPath(node)?.[0] ?? ''
	const rootRefused = context.isServerModule && SERVER_REFUSED_GLOBALS.has(root) && declaringScope(root, ancestors) === undefined
	if (bunMember !== undefined && !rootRefused) context.report(node, 'forbidden-global', `Bun.${path?.[1]} is ${bunMember.what}`, bunMember.allowed)
	if (pathIs(path, 'eval') && (memberPath(node)?.length ?? 0) > 1) context.report(node, 'dynamic-code', 'eval runs a string as code', ALLOWED_CODE)
	if (!context.isGeneratedEntry && (pathIs(path, 'process', 'env') || pathIs(path, 'Bun', 'env'))) {
		context.report(node, 'env-read', `${path?.join('.')} is read outside the generated entrypoint`, ALLOWED_ENV)
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
	const fullPath = memberPath(node)
	const suffix = fullPath ?? memberSuffix(node)
	const helper = suffix[suffix.length - 1] ?? ''
	const receiver = suffix[suffix.length - 2] ?? ''
	// `<x>.sql.raw` by name; a bare `sql.raw` (or an alias's `q.raw`) by the origin of its root.
	const rawHelper = fullPath?.length === 2 ? context.rawSql.has(receiver) : receiver === 'sql'
	if (suffix.length >= 2 && RAW_SQL_HELPERS.has(helper) && rawHelper) {
		context.report(node, 'raw-sql', `${receiver}.${helper} builds raw SQL`, ALLOWED_QUERY)
	}
	if (property === 'innerHTML' || property === 'outerHTML' || property === 'insertAdjacentHTML') {
		context.report(node, 'unsafe-html', `${property} injects markup that runs as the signed-in user`, ALLOWED_MARKUP)
	}
}

/** The site's options: the object literal its builder takes last (`r.query({ … })`, also `{ … } satisfies T` or `as const`). */
const procedureOptions = (procedure: AstNode): AstNode | undefined => {
	const last = children(procedure, 'arguments').at(-1)
	const options = last === null || last === undefined ? undefined : unwrapValue(last)
	return options?.type === 'ObjectExpression' ? options : undefined
}

/** Whether the options declare `sql`; a spread may hold it, so it counts as declaring. */
const declaresSql = (options: AstNode): boolean =>
	children(options, 'properties').some((property) => property === null || property.type === 'SpreadElement' || staticKey(property, 'key') === 'sql')

/**
 * `ctx.sql` (or a job's `tx.sql`) in a `.handle(…)` whose options declare no `sql`: the runtime builds no `ctx.sql`
 * there. A hint, not the boundary: a destructured `ctx` or a helper escapes it, and the runtime refuses anyway.
 */
const checkUndeclaredSql = (node: AstNode, ancestors: readonly AstNode[], context: SourceContext): void => {
	const handle = identifierName(child(node, 'object'))
	if (staticKey(node, 'property') !== 'sql' || (handle !== 'ctx' && handle !== 'tx')) return
	for (let index = ancestors.length - 1; index >= 0; index--) {
		const site = handledProcedure(ancestors[index] ?? node)
		if (site === undefined) continue
		const options = procedureOptions(site.procedure)
		if (options === undefined || declaresSql(options)) return
		const holder = ancestors[index - 1]
		const name = holder?.type === 'Property' ? staticKey(holder, 'key') : undefined
		const where = name === undefined ? `this ${site.builder}` : `'${name}'`
		const reads = site.builder === 'query' || site.builder === 'export'
		context.report(
			node,
			'sql-undeclared',
			`${handle}.sql in the handler of ${where}, whose options declare no sql`,
			reads ? `sql: 'read' in the options of ${where}` : `sql: 'read' in the options of ${where}, or sql: 'write' to write`,
		)
		return
	}
}

/** Inside an ambient `declare`, which types a name and runs nothing. */
const isAmbient = (ancestors: readonly AstNode[]): boolean => ancestors.some((ancestor) => ancestor['declare'] === true)

const checkIdentifier = (node: AstNode, ancestors: readonly AstNode[], context: SourceContext): void => {
	const parent = ancestors[ancestors.length - 1]
	if (!isValueReference(node, parent)) return
	const name = stringField(node, 'name')
	const isMemberObject = parent?.type === 'MemberExpression' && parent['object'] === node
	if (name === 'eval') context.report(node, 'dynamic-code', 'eval runs a string as code', ALLOWED_CODE)
	const isTypeofCheck = parent?.type === 'UnaryExpression' && parent['operator'] === 'typeof'
	const isRefusedName = context.isServerModule && name !== undefined && SERVER_REFUSED_GLOBALS.has(name) && !isTypeofCheck
	// A name the module binds itself (a declaration, a parameter, an import) is its own value, not the global.
	if (isRefusedName && declaringScope(name, ancestors) === undefined && !isAmbient(ancestors)) {
		context.report(node, 'forbidden-global', `${name} is not used in a server module`, 'what the framework hands the handler through ctx or deps')
		return
	}
	if (name === 'Bun' && !isMemberObject) {
		context.report(node, 'forbidden-global', 'Bun used as a value hides which global is reached', 'Bun.<member> written out')
	}
	if (name === 'process' && !isMemberObject && !context.isGeneratedEntry && !isTypeofCheck) {
		context.report(node, 'env-read', 'process used as a value hides a read of process.env', ALLOWED_ENV)
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

const checkPrototypeWrite = (node: AstNode, context: SourceContext): void => {
	const target = node.type === 'AssignmentExpression' ? child(node, 'left') : child(node, 'argument')
	const isWrite = node.type !== 'UnaryExpression' || node['operator'] === 'delete'
	if (isWrite && target !== undefined && touchesPrototype(target)) {
		context.report(node, 'prototype-assignment', 'a write to a prototype patches every instance', ALLOWED_PROTOTYPE)
	}
}

const KEY_PREFIX = 'px_'

const checkStringContent = (node: AstNode, texts: readonly (string | undefined)[], context: SourceContext): void => {
	if (texts.some((text) => text?.includes(KEY_PREFIX))) {
		context.report(
			node,
			'key-literal',
			`'${KEY_PREFIX}' in a literal: a key or a session cookie name in source`,
			'the credential the framework supplies; keys never appear in code',
		)
	}
}

const isTypeOnlyImport = (specifier: AstNode, parent: AstNode | undefined): boolean =>
	stringField(specifier, 'importKind') === 'type' || (parent !== undefined && stringField(parent, 'importKind') === 'type')

const DANGEROUSLY_SET = 'dangerouslySetInnerHTML injects markup that runs as the signed-in user'

/** The rules that read one node at a time, for every source file. */
export const checkRuntimeNode = (node: AstNode, ancestors: readonly AstNode[], context: SourceContext): void => {
	const parent = ancestors[ancestors.length - 1]
	switch (node.type) {
		case 'CallExpression':
		case 'NewExpression':
			return checkCall(node, ancestors, context)
		case 'ImportExpression':
			return checkComputedLoad(node, context)
		case 'MemberExpression':
			checkUndeclaredSql(node, ancestors, context)
			return checkMember(node, ancestors, context)
		case 'Identifier':
			return checkIdentifier(node, ancestors, context)
		case 'VariableDeclarator':
			return checkDestructuredEnv(node, context)
		case 'AssignmentExpression':
		case 'UpdateExpression':
		case 'UnaryExpression':
			return checkPrototypeWrite(node, context)
		case 'TaggedTemplateExpression': {
			const tag = child(node, 'tag')
			const path = tag === undefined ? undefined : memberPath(tag)
			const suffix = tag === undefined ? [] : (path ?? memberSuffix(tag))
			const [root] = suffix
			// A member `.sql` tag by name; a bare tag by its origin, so a parameter that holds the declared ctx.sql is not one.
			const raw = path?.length === 1 ? root !== undefined && context.rawSql.has(root) : suffix[suffix.length - 1] === 'sql'
			if (raw) context.report(node, 'raw-sql', 'an sql`…` template is raw SQL', ALLOWED_QUERY)
			return
		}
		case 'ImportSpecifier': {
			const imported = child(node, 'imported')
			if ((identifierName(imported) ?? staticString(imported)) === 'sql' && !isTypeOnlyImport(node, parent)) {
				context.report(node, 'raw-sql', 'the sql tag imported', ALLOWED_QUERY)
			}
			return
		}
		case 'Literal':
			return checkStringContent(node, [staticString(node)], context)
		case 'TemplateElement': {
			const { raw, cooked } = templateText(node)
			return checkStringContent(node, [raw, cooked], context)
		}
		case 'JSXAttribute': {
			const name = child(node, 'name')
			if (name?.type === 'JSXIdentifier' && stringField(name, 'name') === 'dangerouslySetInnerHTML') {
				context.report(node, 'unsafe-html', DANGEROUSLY_SET, ALLOWED_MARKUP)
			}
			return
		}
		case 'Property':
			if (staticKey(node, 'key') === 'dangerouslySetInnerHTML') context.report(node, 'unsafe-html', DANGEROUSLY_SET, ALLOWED_MARKUP)
			return
	}
}
