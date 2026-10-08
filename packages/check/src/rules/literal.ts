import { type AstNode, child, children, identifierName, isConstAssertion, type ParsedModule, staticKey, staticString, stringField } from '../ast'
import { type Finding, type Report, reporter } from '../finding'
import type { Binding, ModuleGraph } from '../graph'
import { isRelativeSpecifier } from '../layout'

/** What a call root builds; `surface` is the parameter of a builder callback (`c`, `l`). */
export type BuilderKind = 'zod' | 'contract' | 'tables' | 'surface'

/** The only imported names a literal module may use: the builders the platform reads without executing them. */
export const BUILDER_IMPORTS: Readonly<Record<string, Readonly<Record<string, BuilderKind>>>> = {
	'zod/v4': { z: 'zod', '*': 'zod' },
	'@fabrika/app/contract': { defineContract: 'contract' },
	'@fabrika/db': { defineTables: 'tables' },
	'@fabrika/db/tables': { defineTables: 'tables' },
}

const SURFACE_BUILDERS = new Set(['rpc', 'query', 'mutation', 'link', 'spa', 'health', 'form', 'webhook', 'files', 'cron', 'export'])
/** The schema subset the static contract reader (B1) understands; `packages/check/CLAUDE.md` lists it. */
const ZOD_FACTORIES = new Set([
	'strictObject',
	'string',
	'number',
	'int',
	'boolean',
	'null',
	'literal',
	'enum',
	'array',
	'tuple',
	'union',
	'discriminatedUnion',
	'record',
	'optional',
	'nullable',
	'uuid',
	'email',
	'url',
])
const ZOD_ISO_FORMATS = new Set(['date', 'datetime', 'time', 'duration'])
const ZOD_METHODS = new Set([
	'min',
	'max',
	'length',
	'nonempty',
	'email',
	'uuid',
	'url',
	'startsWith',
	'endsWith',
	'includes',
	'int',
	'positive',
	'negative',
	'nonnegative',
	'nonpositive',
	'gt',
	'gte',
	'lt',
	'lte',
	'multipleOf',
	'regex',
	'optional',
	'nullable',
	'nullish',
	'default',
	'describe',
	'array',
	'or',
	'extend',
	'pick',
	'omit',
	'partial',
])
/** Named apart because an agent reaches for them first: each runs application code or admits undeclared keys. */
const ZOD_UNSERIALIZABLE = new Set([
	'transform',
	'refine',
	'superRefine',
	'preprocess',
	'overwrite',
	'check',
	'pipe',
	'catch',
	'custom',
	'lazy',
	'function',
	'instanceof',
	'codec',
	'passthrough',
	'loose',
	'looseObject',
	'catchall',
])

const ALLOWED_VALUE = 'object and array literals, strings, numbers, booleans, null, the c.* and z.* builders, and const imports of such values'
const ALLOWED_SCHEMA = 'a schema of the supported z subset (packages/check/CLAUDE.md): strict objects, no transforms, refinements or pipes'
const ALLOWED_CALLBACK = 'a function only as the builder callback of defineContract(…, (c) => ({ … })) or of a link: procedures: (l) => ({ … })'
const ALLOWED_IMPORT =
	'z from zod/v4, defineContract from @fabrika/app/contract, defineTables from @fabrika/db or @fabrika/db/tables, or a literal const of the application'

export type Link = { readonly kind: 'member'; readonly name: string | undefined; readonly node: AstNode } | {
	readonly kind: 'call'
	readonly node: AstNode
}

/** `z['string']()` names the same builder, but a key read through a const is no longer a name the reader sees. */
export const isComputedMember = (link: Link): boolean => link.kind === 'member' && link.node['computed'] === true

/** `z.string().min(1)` → root `z`, links `.string` `()` `.min` `(1)`. */
export const decompose = (node: AstNode): { readonly root: AstNode; readonly links: readonly Link[] } => {
	const links: Link[] = []
	let current = node
	for (;;) {
		const inner = child(current, current.type === 'CallExpression' ? 'callee' : 'object')
		if (inner === undefined || (current.type !== 'CallExpression' && current.type !== 'MemberExpression')) break
		links.unshift(
			current.type === 'CallExpression' ? { kind: 'call', node: current } : { kind: 'member', name: staticKey(current, 'property'), node: current },
		)
		current = inner
	}
	return { root: current, links }
}

interface Problem {
	readonly node: AstNode
	readonly message: string
	readonly allowed: string
}

const memberProblem = (link: Link | undefined, allowed: ReadonlySet<string>, where: string, fallback: AstNode): Problem | undefined => {
	if (link?.kind !== 'member') return { node: link?.node ?? fallback, message: `${where} must name a builder`, allowed: ALLOWED_SCHEMA }
	const name = link.name
	if (name === undefined) return { node: link.node, message: 'computed builder name', allowed: ALLOWED_SCHEMA }
	if (name === 'object') {
		return { node: link.node, message: 'z.object() strips undeclared keys instead of refusing them', allowed: 'z.strictObject({ … })' }
	}
	if (ZOD_UNSERIALIZABLE.has(name)) return { node: link.node, message: `'.${name}()' makes the schema unserializable`, allowed: ALLOWED_SCHEMA }
	if (!allowed.has(name)) return { node: link.node, message: `'${name}' is not in the supported schema subset`, allowed: ALLOWED_SCHEMA }
	return undefined
}

const calledProblem = (link: Link | undefined, previous: Link): Problem | undefined =>
	link?.kind === 'call' ? undefined : { node: previous.node, message: 'a schema builder that is not called', allowed: ALLOWED_SCHEMA }

const zodChainProblem = (root: AstNode, links: readonly Link[]): Problem | undefined => {
	const first = links[0]
	let next = 2
	if (first?.kind === 'member' && first.name === 'iso') {
		const format = links[1]
		const problem = memberProblem(format, ZOD_ISO_FORMATS, 'z.iso', first.node)
		if (problem !== undefined || format === undefined) return problem
		next = 3
		const called = calledProblem(links[2], format)
		if (called !== undefined) return called
	} else {
		const problem = memberProblem(first, ZOD_FACTORIES, 'z', root)
		if (problem !== undefined || first === undefined) return problem
		const called = calledProblem(links[1], first)
		if (called !== undefined) return called
	}
	for (let index = next; index < links.length; index += 2) {
		const method = links[index]
		const problem = memberProblem(method, ZOD_METHODS, 'a schema method', root)
		if (problem !== undefined || method === undefined) return problem
		const called = calledProblem(links[index + 1], method)
		if (called !== undefined) return called
	}
	return stringOrderProblem(links, next)
}

const STRING_FACTORIES = new Set(['string', 'uuid', 'email', 'url', 'iso'])
const FORMATS = new Set(['uuid', 'email', 'url', 'iso'])
const AFFIXES = new Set(['startsWith', 'endsWith', 'includes'])
const STRING_CHECKS = new Set(['min', 'max', 'length', 'nonempty', 'regex', ...AFFIXES])
/** Methods after which the chain no longer checks the string itself. */
const WRAPPERS = new Set(['optional', 'nullable', 'nullish', 'default', 'array', 'or'])

/**
 * The artifact keeps a string's checks unordered (`@fabrika/app`'s schema-shape.ts), so the chain may not depend on
 * their order: `z.url()` rewrites the value the checks after it see, and an affix overlaps a format.
 */
const stringOrderProblem = (links: readonly Link[], firstMethod: number): Problem | undefined => {
	const [factory] = links
	if (factory?.kind !== 'member' || factory.name === undefined || !STRING_FACTORIES.has(factory.name)) return undefined
	let formats = FORMATS.has(factory.name) ? 1 : 0
	let url = factory.name === 'url'
	let affix = false
	let checks = false
	for (let index = firstMethod; index < links.length; index += 2) {
		const method = links[index]
		const name = method?.kind === 'member' ? method.name : undefined
		if (method === undefined || name === undefined || WRAPPERS.has(name)) return undefined
		formats += FORMATS.has(name) ? 1 : 0
		url ||= name === 'url'
		affix ||= AFFIXES.has(name)
		checks ||= STRING_CHECKS.has(name)
		if (formats > 1) return { node: method.node, message: 'a string with two formats', allowed: 'one format per string' }
		if (url && checks) {
			return {
				node: method.node,
				message: 'z.url() rewrites the value, so another string check depends on its order',
				allowed: 'z.url() with no other check',
			}
		}
		if (formats > 0 && affix) {
			return { node: method.node, message: '.startsWith(), .endsWith() and .includes() do not combine with a format', allowed: 'one or the other' }
		}
	}
	return undefined
}

const shapeProblem = (kind: BuilderKind, root: AstNode, links: readonly Link[]): Problem | undefined => {
	const calls = links.filter((link) => link.kind === 'call').length
	switch (kind) {
		case 'zod':
			return zodChainProblem(root, links)
		case 'surface': {
			const [method, call] = links
			const name = method?.kind === 'member' ? method.name : undefined
			if (name === undefined || !SURFACE_BUILDERS.has(name) || call?.kind !== 'call' || links.length !== 2) {
				return { node: method?.node ?? root, message: 'not a call of a contract builder', allowed: `one of c.${[...SURFACE_BUILDERS].join(', c.')}(…)` }
			}
			return undefined
		}
		case 'contract':
			return links.length === 1 && calls === 1
				? undefined
				: { node: root, message: 'defineContract used other than as one call', allowed: 'defineContract(vocabulary, (c) => ({ … }))' }
		case 'tables':
			return calls === links.length && (calls === 1 || calls === 2)
				? undefined
				: { node: root, message: 'defineTables used other than as its call', allowed: 'defineTables<DB, Action>(columns)({ … })' }
	}
}

const offset = (node: AstNode | undefined): number | undefined => (typeof node?.['start'] === 'number' ? node['start'] : undefined)

/** Whether `reference` stands before `declaration` in the source: evaluating it would read the const uninitialized. */
const isBefore = (reference: AstNode, declaration: AstNode | undefined): boolean => {
	const at = offset(reference)
	const declared = offset(declaration)
	return at !== undefined && declared !== undefined && at < declared
}

interface ConstInfo {
	readonly node: AstNode
	/** The initializer itself has no finding. */
	readonly clean: boolean
	/** Top-level names the initializer refers to: consts of this module and imports. */
	readonly dependencies: readonly string[]
}

interface LiteralSummary {
	readonly module: ParsedModule
	readonly consts: ReadonlyMap<string, ConstInfo>
	readonly report: Report
}

const readModule = (module: ParsedModule, graph: ModuleGraph, findings: Finding[]): LiteralSummary => {
	const report = reporter(module.file, findings)
	const index = graph.index(module)
	const builders = new Map<string, BuilderKind>()
	for (const binding of index.imports.values()) {
		const kind = BUILDER_IMPORTS[binding.specifier]?.[binding.imported]
		if (kind !== undefined) builders.set(binding.local, kind)
	}
	const consts = new Map<string, ConstInfo>()
	let reported = 0
	const fail = (node: AstNode, message: string, allowed: string = ALLOWED_VALUE) => {
		reported++
		report(node, 'literal', message, allowed)
	}

	type Scope = ReadonlyMap<string, BuilderKind>

	const checkIdentifier = (node: AstNode, scope: Scope, dependencies: string[]): void => {
		const name = identifierName(node) ?? ''
		if (scope.has(name) || builders.has(name)) return fail(node, `'${name}' used as a value`, `${name}.<builder>(…) calls only`)
		if (index.consts.has(name) && isBefore(node, index.consts.get(name))) {
			return fail(node, `'${name}' is used before its declaration, where the module cannot read it yet`, 'declare a const above its first use')
		}
		if (index.consts.has(name) || index.imports.has(name)) {
			dependencies.push(name)
			return
		}
		if (index.others.has(name)) return fail(node, `'${name}' is not a const`, 'a top-level const in this file, or a named import of one')
		fail(node, `unknown identifier '${name}'`, 'a top-level const in this file, or a named import of one')
	}

	const checkBuilderCallback = (node: AstNode, scope: Scope, dependencies: string[]): void => {
		const parameters = children(node, 'params')
		const parameter = parameters.length === 1 ? identifierName(parameters[0] ?? undefined) : undefined
		const body = child(node, 'body')
		if (node.type !== 'ArrowFunctionExpression') {
			return fail(node, 'the builder callback is not written here', 'an inline arrow function: (c) => ({ … })')
		}
		if (parameter === undefined || body === undefined || body.type === 'BlockStatement' || node['async'] === true) {
			return fail(node, 'a builder callback of another shape', 'one parameter and an expression body: (c) => ({ … })')
		}
		checkExpression(body, new Map([...scope, [parameter, 'surface']]), dependencies)
	}

	/** `callback` and `link-options` are the documented builder-callback positions; `pattern` is the argument of `.regex()`. */
	const checkArgument = (argument: AstNode, scope: Scope, dependencies: string[], role: 'callback' | 'link-options' | 'pattern' | 'value'): void => {
		if (argument.type === 'SpreadElement') return fail(argument, 'spread', 'the arguments written out')
		if (role === 'callback') return checkBuilderCallback(argument, scope, dependencies)
		if (role === 'link-options' && argument.type === 'ObjectExpression') return checkObject(argument, scope, dependencies, 'procedures')
		if (role === 'pattern' && argument.type === 'Literal' && argument['regex'] !== undefined) return
		checkExpression(argument, scope, dependencies)
	}

	const checkCall = (node: AstNode, scope: Scope, dependencies: string[]): void => {
		const { root, links } = decompose(node)
		const rootName = identifierName(root)
		const kind = rootName === undefined ? undefined : (scope.get(rootName) ?? builders.get(rootName))
		if (kind === undefined) {
			return fail(node, 'call of a function that is not c.*, z.* or define*', 'the value the function returns, written as a literal')
		}
		const computed = links.find(isComputedMember)
		if (computed !== undefined) return fail(computed.node, 'a computed builder member', `${rootName}.<builder>(…) written with a dot`)
		const problem = shapeProblem(kind, root, links)
		if (problem !== undefined) return fail(problem.node, problem.message, problem.allowed)
		const builder = links[0]?.kind === 'member' ? links[0].name : undefined
		links.forEach((link, index) => {
			if (link.kind !== 'call') return
			if (link.node['optional'] === true) fail(link.node, 'optional call', 'a plain call')
			const previous = links[index - 1]
			const method = previous?.kind === 'member' ? previous.name : undefined
			children(link.node, 'arguments').forEach((argument, position) => {
				if (argument === null) return
				if (kind === 'contract' && position === 1) checkArgument(argument, scope, dependencies, 'callback')
				else if (kind === 'surface' && builder === 'link' && position === 1) checkArgument(argument, scope, dependencies, 'link-options')
				else if (kind === 'zod' && method === 'regex' && position === 0) checkArgument(argument, scope, dependencies, 'pattern')
				else checkArgument(argument, scope, dependencies, 'value')
			})
		})
	}

	const checkObject = (node: AstNode, scope: Scope, dependencies: string[], callbackKey?: string): void => {
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
			if (staticKey(property, 'key') === '__proto__') {
				fail(property, 'a __proto__ key sets the prototype instead of a field', 'another key name')
				continue
			}
			const value = child(property, 'value')
			if (value === undefined) continue
			if (callbackKey !== undefined && staticKey(property, 'key') === callbackKey) checkBuilderCallback(value, scope, dependencies)
			else checkExpression(value, scope, dependencies)
		}
	}

	const checkExpression = (node: AstNode, scope: Scope, dependencies: string[]): void => {
		switch (node.type) {
			case 'Literal':
				if (node['regex'] !== undefined) return fail(node, 'regular expression literal outside .regex()', 'z.string().regex(/…/)')
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
				if (inner !== undefined) checkExpression(inner, scope, dependencies)
				return
			}
			case 'TSAsExpression': {
				const inner = child(node, 'expression')
				if (!isConstAssertion(node)) return fail(node, 'type assertion `as T`', '`as const` or `satisfies T`')
				if (inner !== undefined) checkExpression(inner, scope, dependencies)
				return
			}
			case 'ArrayExpression':
				for (const element of children(node, 'elements')) {
					if (element === null) fail(node, 'array hole', 'every element written out')
					else if (element.type === 'SpreadElement') fail(element, 'spread', 'the elements written out')
					else checkExpression(element, scope, dependencies)
				}
				return
			case 'ObjectExpression':
				return checkObject(node, scope, dependencies)
			case 'Identifier':
				return checkIdentifier(node, scope, dependencies)
			case 'ArrowFunctionExpression':
			case 'FunctionExpression':
				return fail(node, 'function', ALLOWED_CALLBACK)
			case 'CallExpression':
				return checkCall(node, scope, dependencies)
			case 'BinaryExpression':
			case 'LogicalExpression':
				return fail(node, `operator '${String(node['operator'])}'`, 'the resulting value written as a literal')
			default:
				return fail(node, `${node.type} is not a literal`, ALLOWED_VALUE)
		}
	}

	const checkInitializer = (name: string, node: AstNode, init: AstNode): void => {
		const before = reported
		const dependencies: string[] = []
		checkExpression(init, new Map(), dependencies)
		consts.set(name, { node, clean: reported === before, dependencies })
	}

	for (const statement of children(module.program, 'body')) {
		if (statement === null) continue
		if (statement.type === 'ImportDeclaration') {
			if (children(statement, 'specifiers').length === 0) {
				fail(statement, `side-effect import of '${staticString(child(statement, 'source')) ?? ''}'`, 'named imports of literal consts')
			}
			continue
		}
		const declaration = statement.type === 'ExportNamedDeclaration' ? (child(statement, 'declaration') ?? statement) : statement
		if (declaration.type === 'TSTypeAliasDeclaration' || declaration.type === 'TSInterfaceDeclaration') continue
		if (declaration.type === 'ExportNamedDeclaration') {
			if (child(declaration, 'source') !== undefined) {
				fail(declaration, 're-export', 'import the const, then export it')
				continue
			}
			for (const item of children(declaration, 'specifiers')) {
				const local = item ? identifierName(child(item, 'local')) : undefined
				if (item !== null && local !== undefined && !index.consts.has(local) && !index.imports.has(local)) {
					fail(item, `exports '${local}', which is not a const of this module`, 'export a top-level const')
				}
			}
			continue
		}
		if (declaration.type === 'ExportDefaultDeclaration') {
			const exported = child(declaration, 'declaration')
			if (exported !== undefined) checkInitializer('default', declaration, exported)
			continue
		}
		if (declaration.type === 'VariableDeclaration') {
			const kind = stringField(declaration, 'kind') ?? ''
			if (kind !== 'const') {
				fail(declaration, `'${kind}' declaration`, 'a top-level const')
				continue
			}
			for (const declarator of children(declaration, 'declarations')) {
				if (declarator === null) continue
				const name = identifierName(child(declarator, 'id'))
				const init = child(declarator, 'init')
				if (name === undefined || init === undefined) fail(declarator, 'destructuring or a missing initializer', 'const <name> = <literal>')
				else checkInitializer(name, declarator, init)
			}
			continue
		}
		fail(statement, `top-level ${declaration.type}`, 'only imports, types and const declarations of literals; move code out of the contract graph')
	}
	return { module, consts, report }
}

/**
 * The contract, its schema modules and the table policies are literals (D5), so that the platform can read them from a
 * commit without executing them. `entries` are the graph's roots; relative value imports pull further modules in.
 */
export const checkLiteralGraph = (entries: readonly string[], graph: ModuleGraph): Finding[] => {
	const findings: Finding[] = []
	const summaries = new Map<string, LiteralSummary>()
	const queue = entries.map((entry) => graph.module(entry)).filter((module) => module !== undefined)
	for (let module = queue.shift(); module !== undefined; module = queue.shift()) {
		if (summaries.has(module.file)) continue
		summaries.set(module.file, readModule(module, graph, findings))
		for (const binding of graph.index(module).imports.values()) {
			const target = graph.resolve(module.file, binding.specifier)
			if (target !== undefined) queue.push(target)
		}
	}
	reportImportCycles(summaries, graph)

	const states = new Map<string, 'visiting' | boolean>()
	const cycles = new Set<string>()
	/** Whether a binding is a literal all the way down; a const defined through itself is reported at the const re-entered. */
	const isLiteral = (binding: Binding): boolean => {
		if (binding.kind === 'package') return BUILDER_IMPORTS[binding.specifier]?.[binding.imported] !== undefined
		if (binding.kind !== 'const' && binding.kind !== 'default') return false
		const name = binding.kind === 'const' ? binding.name : 'default'
		const summary = summaries.get(binding.module.file)
		const info = summary?.consts.get(name)
		if (summary === undefined || info === undefined || !info.clean) return false
		const key = `${binding.module.file}#${name}`
		const state = states.get(key)
		if (state === 'visiting') {
			if (!cycles.has(key)) {
				summary.report(info.node, 'literal', `'${name}' is defined through itself`, 'a const whose value is written out as a literal')
			}
			cycles.add(key)
			return false
		}
		if (state !== undefined) return state
		states.set(key, 'visiting')
		const literal = info.dependencies.every((dependency) => isLiteral(graph.binding(binding.module, dependency)))
		states.set(key, literal)
		return literal
	}

	for (const summary of summaries.values()) {
		for (const name of summary.consts.keys()) {
			isLiteral(name === 'default' ? graph.exported(summary.module, 'default') : graph.binding(summary.module, name))
		}
		for (const imported of graph.index(summary.module).imports.values()) {
			if (!isRelativeSpecifier(imported.specifier)) {
				if (BUILDER_IMPORTS[imported.specifier]?.[imported.imported] === undefined) {
					summary.report(imported.node, 'literal', `value import of '${imported.imported}' from the package '${imported.specifier}'`, ALLOWED_IMPORT)
				}
				continue
			}
			if (imported.imported === '*') {
				summary.report(imported.node, 'literal', `namespace import of '${imported.specifier}'`, 'named imports of literal consts')
				continue
			}
			const resolution = graph.resolution(summary.module.file, imported.specifier)
			if (resolution.kind === 'ambiguous' || resolution.kind === 'directory') {
				const what = resolution.kind === 'ambiguous'
					? `resolves to each of ${resolution.paths.join(', ')}`
					: `is a directory import (${resolution.paths.join(', ')})`
				summary.report(
					imported.node,
					'literal',
					`'${imported.specifier}' ${what}, which the platform does not resolve as Bun does`,
					'a relative import that names the module file, extension included',
				)
				continue
			}
			const binding = graph.binding(summary.module, imported.local)
			if (binding.kind === 'unresolved') summary.report(imported.node, 'literal', binding.reason, 'a named import of a const the module exports')
			else if (!isLiteral(binding)) {
				summary.report(
					imported.node,
					'literal',
					`'${imported.imported}' from '${imported.specifier}' is not a literal const`,
					'an import of a const whose value is a literal',
				)
			}
		}
	}
	return findings
}

/** An import cycle among literal modules: one of them is evaluated while the other's consts are still uninitialized. */
const reportImportCycles = (summaries: ReadonlyMap<string, LiteralSummary>, graph: ModuleGraph): void => {
	const state = new Map<string, 'visiting' | 'done'>()
	const visit = (summary: LiteralSummary): void => {
		state.set(summary.module.file, 'visiting')
		for (const imported of graph.index(summary.module).imports.values()) {
			const target = graph.resolve(summary.module.file, imported.specifier)
			const next = target === undefined ? undefined : summaries.get(target.file)
			if (next === undefined) continue
			const seen = state.get(next.module.file)
			if (seen === 'visiting') {
				summary.report(
					imported.node,
					'literal',
					`'${imported.specifier}' closes an import cycle`,
					'a module graph without cycles: move the shared consts into one module',
				)
			} else if (seen === undefined) visit(next)
		}
		state.set(summary.module.file, 'done')
	}
	for (const summary of summaries.values()) {
		if (!state.has(summary.module.file)) visit(summary)
	}
}
