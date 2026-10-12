// Reads the literal subset of `rules/literal.ts` into values, without executing the application: names resolve through
// `ModuleGraph`, `z` chains build real zod schemas, `c.*` calls stay unapplied for `surface.ts`.

import type { z } from 'zod/v4'
import { type AstNode, child, children, identifierName, isConstAssertion, type ParsedModule, staticKey } from '../ast'
import type { Located, ModuleGraph } from '../graph'
import { CONTRACT_LIMITS } from '../limits'
import { BUILDER_IMPORTS, type BuilderKind, decompose, isComputedMember, isKitName, KIT_BUILDERS, KIT_CALLBACKS, type Link } from '../rules/literal'
import type { ReaderProblems } from './problems'
import { buildSchema } from './schema'

/**
 * The builder kit a call belongs to: `c` of `defineContract` and `l` of its link's `procedures`; `app`, the kit
 * `defineApp` returned; `c` of `app.contract` (`shell`) and `r` of a group, a link or an export (`endpoints`).
 */
export type Kit = 'surface' | 'link' | 'app' | 'shell' | 'endpoints'

/** The parameter name a kit is written with, in messages. */
export const kitName = (kit: Kit): string => (kit === 'link' ? 'l' : kit === 'app' ? 'app' : kit === 'endpoints' ? 'r' : 'c')

export type LiteralValue =
	| { readonly kind: 'string'; readonly value: string; readonly at: Located }
	| { readonly kind: 'number'; readonly value: number; readonly at: Located }
	| { readonly kind: 'boolean'; readonly value: boolean; readonly at: Located }
	| { readonly kind: 'null'; readonly at: Located }
	| { readonly kind: 'regex'; readonly value: RegExp; readonly at: Located }
	| { readonly kind: 'array'; readonly items: readonly LiteralValue[]; readonly at: Located }
	/** Entries in source order; a repeated key keeps its first position and its last value, as in an object literal. */
	| { readonly kind: 'object'; readonly entries: ReadonlyMap<string, LiteralValue>; readonly at: Located }
	/** `nodes` counts the schema with every shared part expanded, as the artifact will hold it; `depth` its nesting. */
	| { readonly kind: 'schema'; readonly schema: z.ZodType; readonly nodes: number; readonly depth: number; readonly at: Located }
	/** `c.rpc(…)` or `l.query(…)`, with its arguments read. */
	| { readonly kind: 'builder'; readonly kit: Kit; readonly name: string; readonly args: readonly LiteralValue[]; readonly at: Located }
	| { readonly kind: 'contract'; readonly args: readonly LiteralValue[]; readonly at: Located }
	/** `defineApp(vocabulary, tables, options?)`: the vocabulary and the options; the tables are `src/db/tables.ts`'. */
	| AppValue
	/** `app.contract((c) => ({ … }))`, with the kit it was called on. */
	| { readonly kind: 'kit-contract'; readonly app: AppValue; readonly args: readonly LiteralValue[]; readonly at: Located }
	/** A builder callback: its parameter is only ever a kit, so its body is read once, as a value. */
	| { readonly kind: 'callback'; readonly result: LiteralValue; readonly at: Located }

export interface AppValue {
	readonly kind: 'app'
	readonly vocabulary: LiteralValue
	readonly options: LiteralValue | undefined
	readonly at: Located
}

type Scope = ReadonlyMap<string, Kit>

/**
 * Where a callback may stand, as `rules/literal.ts` allows it: a builder's callback argument, or the `procedures` of
 * its options (a link, an export).
 */
type Role = { readonly callback: Kit } | { readonly procedures: Kit } | null

/** The value kit of a callback parameter whose builder kind `rules/literal.ts` names. */
const callbackKit = (kind: BuilderKind): Kit => (kind === 'shell' ? 'shell' : kind === 'endpoints' ? 'endpoints' : 'surface')

/** The fields `defineVocabulary` copies from its argument, in its order. */
const VOCABULARY_SECTIONS = ['app', 'dimensions', 'actions', 'roles'] as const

const ALLOWED_VALUE = 'object and array literals, strings, numbers, booleans, null, the c.* and z.* builders, and const imports of such values'

export class ValueReader {
	readonly #graph: ModuleGraph
	readonly #problems: ReaderProblems
	/** Each const is read once, so a schema const used twice is one schema, as when the module is evaluated. */
	readonly #consts = new Map<string, LiteralValue | null | 'reading'>()

	constructor(graph: ModuleGraph, problems: ReaderProblems) {
		this.#graph = graph
		this.#problems = problems
	}

	/** The value of one expression outside any builder callback, or `null` after recording why there is none. */
	value(located: Located): LiteralValue | null {
		return this.#read(located, new Map(), null)
	}

	/** The value `name` is exported as from `module`, or `null` after recording why there is none. */
	exported(module: ParsedModule, name: string, at: AstNode): LiteralValue | null {
		const binding = this.#graph.exported(module, name)
		if (binding.kind === 'const' && binding.init !== undefined) {
			return this.#const(binding.module, binding.name, binding.init)
		}
		if (binding.kind === 'default') {
			return this.#const(binding.module, 'default', binding.expression)
		}
		this.#problems.add({ module, node: at }, `'${module.file}' exports no const '${name}'`, `export const ${name} = …`)
		return null
	}

	#const(module: ParsedModule, name: string, init: AstNode): LiteralValue | null {
		const key = `${module.file}#${name}`
		const known = this.#consts.get(key)
		if (known === 'reading') {
			this.#problems.add({ module, node: init }, `'${name}' is defined through itself`, 'a const whose value is written out as a literal')
			return null
		}
		if (known !== undefined) {
			return known
		}
		this.#consts.set(key, 'reading')
		const value = this.#read({ module, node: init }, new Map(), null)
		this.#consts.set(key, value)
		return value
	}

	#read(located: Located, scope: Scope, role: Role): LiteralValue | null {
		const { module, node } = located
		const fail = (message: string, allowed = ALLOWED_VALUE): null => {
			this.#problems.add(located, message, allowed)
			return null
		}
		switch (node.type) {
			case 'Literal':
				return this.#literal(located)
			case 'TemplateLiteral': {
				const quasi = children(node, 'quasis')[0]
				const cooked = quasi ? templateCooked(quasi) : undefined
				return children(node, 'expressions').length === 0 && cooked !== undefined
					? { kind: 'string', value: cooked, at: located }
					: fail('a template literal with ${…} or an invalid escape', 'a plain string')
			}
			case 'UnaryExpression': {
				const argument = child(node, 'argument')
				const value = argument?.type === 'Literal' ? argument['value'] : undefined
				return node['operator'] === '-' && typeof value === 'number'
					? { kind: 'number', value: -value, at: located }
					: fail(`unary '${String(node['operator'])}'`, 'the resulting value written as a literal')
			}
			case 'TSSatisfiesExpression':
			case 'TSAsExpression': {
				const inner = child(node, 'expression')
				if (node.type === 'TSAsExpression' && !isConstAssertion(node)) {
					return fail('type assertion `as T`', '`as const` or `satisfies T`')
				}
				return inner === undefined ? fail('an empty expression') : this.#read({ module, node: inner }, scope, role)
			}
			case 'ArrayExpression':
				return this.#array(located, scope)
			case 'ObjectExpression':
				return this.#object(located, scope, role !== null && 'procedures' in role ? role.procedures : null)
			case 'Identifier':
				return this.#identifier(located, scope)
			case 'ArrowFunctionExpression':
				return role !== null && 'callback' in role
					? this.#callback(located, scope, role.callback)
					: fail(
						'function',
						'a function only as a builder callback: defineContract(…, (c) => …), app.contract((c) => …), app.group(…, (r) => …), procedures: (l) => …',
					)
			case 'CallExpression':
				return this.#call(located, scope)
			default:
				return fail(`${node.type} is not a literal`)
		}
	}

	#literal(located: Located): LiteralValue | null {
		const { node } = located
		const value = node['value']
		const regex = node['regex']
		if (regex !== undefined) {
			const pattern = isRecord(regex) ? regex['pattern'] : undefined
			const flags = isRecord(regex) ? regex['flags'] : undefined
			const compiled = typeof pattern === 'string' && typeof flags === 'string' ? compile(pattern, flags) : undefined
			if (compiled === undefined) {
				this.#problems.add(located, 'a regular expression the reader cannot compile', 'a regular expression literal without errors')
				return null
			}
			return { kind: 'regex', value: compiled, at: located }
		}
		if (node['bigint'] !== undefined) {
			this.#problems.add(located, 'bigint literal', 'a number or a string')
			return null
		}
		if (typeof value === 'string') {
			return { kind: 'string', value, at: located }
		}
		if (typeof value === 'number') {
			return { kind: 'number', value, at: located }
		}
		if (typeof value === 'boolean') {
			return { kind: 'boolean', value, at: located }
		}
		if (value === null) {
			return { kind: 'null', at: located }
		}
		this.#problems.add(located, 'a literal the reader does not know', ALLOWED_VALUE)
		return null
	}

	#array(located: Located, scope: Scope): LiteralValue | null {
		const items: LiteralValue[] = []
		let complete = true
		for (const element of children(located.node, 'elements')) {
			if (element === null || element.type === 'SpreadElement') {
				this.#problems.add(element === null ? located : { module: located.module, node: element }, 'array hole or spread', 'every element written out')
				complete = false
				continue
			}
			const item = this.#read({ module: located.module, node: element }, scope, null)
			if (item === null) {
				complete = false
			} else {
				items.push(item)
			}
		}
		return complete ? { kind: 'array', items, at: located } : null
	}

	#object(located: Located, scope: Scope, procedures: Kit | null): LiteralValue | null {
		const entries = new Map<string, LiteralValue>()
		let complete = true
		for (const property of children(located.node, 'properties')) {
			if (property === null) {
				continue
			}
			const at = { module: located.module, node: property }
			const key = staticKey(property, 'key')
			const value = child(property, 'value')
			if (
				property.type !== 'Property' || property['computed'] === true || property['kind'] !== 'init' || property['method'] === true
				|| key === undefined || key === '__proto__' || value === undefined
			) {
				this.#problems.add(at, 'a spread, computed key, method or __proto__ key', 'a plain or quoted key with a literal value')
				complete = false
				continue
			}
			const role: Role = procedures !== null && key === 'procedures' ? { callback: procedures } : null
			const read = this.#read({ module: located.module, node: value }, scope, role)
			if (read === null) {
				complete = false
			} else {
				entries.set(key, read)
			}
		}
		return complete ? { kind: 'object', entries, at: located } : null
	}

	#identifier(located: Located, scope: Scope): LiteralValue | null {
		const name = identifierName(located.node) ?? ''
		const builder = this.#builderOf(located.module, name)
		if (scope.has(name) || builder !== undefined || isKitName(this.#graph, located.module, name)) {
			this.#problems.add(located, `'${name}' used as a value`, `${name}.<builder>(…) calls only`)
			return null
		}
		const binding = this.#graph.binding(located.module, name)
		if (binding.kind === 'const' && binding.init !== undefined) {
			return this.#const(binding.module, binding.name, binding.init)
		}
		if (binding.kind === 'default') {
			return this.#const(binding.module, 'default', binding.expression)
		}
		const reason = binding.kind === 'unresolved' ? binding.reason : `'${name}' is not a const`
		this.#problems.add(located, reason, 'a top-level const in this file, or a named import of one')
		return null
	}

	#callback(located: Located, scope: Scope, kit: Kit): LiteralValue | null {
		const { node } = located
		const parameters = children(node, 'params')
		const parameter = parameters.length === 1 ? identifierName(parameters[0] ?? undefined) : undefined
		const body = child(node, 'body')
		if (parameter === undefined || body === undefined || body.type === 'BlockStatement' || node['async'] === true) {
			this.#problems.add(located, 'a builder callback of another shape', 'one parameter and an expression body: (c) => ({ … })')
			return null
		}
		const result = this.#read({ module: located.module, node: body }, new Map([...scope, [parameter, kit]]), null)
		return result === null ? null : { kind: 'callback', result, at: located }
	}

	#call(located: Located, scope: Scope): LiteralValue | null {
		const { root, links } = decompose(located.node)
		const rootName = identifierName(root) ?? ''
		const kit = scope.get(rootName)
		const optional = links.find((link) => link.kind === 'call' && link.node['optional'] === true)
		if (optional !== undefined) {
			this.#problems.add({ module: located.module, node: optional.node }, 'optional call', 'a plain call')
			return null
		}
		const computed = links.find(isComputedMember)
		if (computed !== undefined) {
			this.#problems.add({ module: located.module, node: computed.node }, 'a computed builder member', `${rootName}.<builder>(…) written with a dot`)
			return null
		}
		if (kit !== undefined) {
			return this.#kitCall(located, kit, links, scope)
		}
		if (isKitName(this.#graph, located.module, rootName)) {
			return this.#appMethodCall(located, rootName, links, scope)
		}
		switch (this.#builderOf(located.module, rootName)) {
			case 'zod':
				return this.#zodChain(located, links, scope)
			case 'contract':
				return this.#contractCall(located, links, scope)
			case 'vocabulary':
				return this.#vocabularyCall(located, links, scope)
			case 'app':
				return this.#appCall(located, links, scope)
			case 'tables':
				this.#problems.add(located, 'defineTables in the contract graph', 'table policies only in src/db/tables.ts')
				return null
			default:
				this.#problems.add(located, 'call of a function that is not c.*, z.* or defineContract', 'the value the function returns, written as a literal')
				return null
		}
	}

	#kitCall(located: Located, kit: Kit, links: readonly Link[], scope: Scope): LiteralValue | null {
		const [method, call] = links
		const name = method?.kind === 'member' ? method.name : undefined
		if (name === undefined || call?.kind !== 'call' || links.length !== 2) {
			this.#problems.add(
				located,
				'not a call of a contract builder',
				kit === 'link' || kit === 'endpoints' ? `${kitName(kit)}.query(…) or ${kitName(kit)}.mutation(…)` : 'c.<builder>(…)',
			)
			return null
		}
		const args = this.#arguments(
			located.module,
			call.node,
			scope,
			(position) => (kit === 'surface' && name === 'link' && position === 1 ? { procedures: 'link' } : null),
		)
		return args === null ? null : { kind: 'builder', kit, name, args, at: located }
	}

	/**
	 * `defineApp(vocabulary)` or `defineApp(vocabulary, tables, options?)`. The tables are not read here: `src/db/tables.ts` is read on its own
	 * (`readTablesSource`), and the runtime takes them for the types only.
	 */
	#appCall(located: Located, links: readonly Link[], scope: Scope): LiteralValue | null {
		const [call] = links
		const argumentNodes = call?.kind === 'call' && links.length === 1 ? children(call.node, 'arguments') : []
		if (call?.kind !== 'call' || links.length !== 1 || argumentNodes.length < 1 || argumentNodes.length > 3) {
			this.#problems.add(
				located,
				'defineApp used other than as one call of the vocabulary, the tables and its options',
				'defineApp(vocabulary, tables, { imports })',
			)
			return null
		}
		const read = (node: AstNode | null | undefined): LiteralValue | null | undefined => {
			if (node === undefined) return undefined
			if (node === null || node.type === 'SpreadElement') {
				this.#problems.add({ module: located.module, node: node ?? call.node }, 'spread', 'the arguments written out')
				return null
			}
			return this.#read({ module: located.module, node }, scope, null)
		}
		const vocabulary = read(argumentNodes[0])
		const options = read(argumentNodes[2])
		if (vocabulary === null || vocabulary === undefined || options === null) {
			return null
		}
		return { kind: 'app', vocabulary, options, at: located }
	}

	/** `app.<builder>(…)` on the kit a const `defineApp(…)` returned; its callbacks are read with the kit they hand. */
	#appMethodCall(located: Located, rootName: string, links: readonly Link[], scope: Scope): LiteralValue | null {
		const [method, call] = links
		const name = method?.kind === 'member' ? method.name : undefined
		if (name === undefined || !KIT_BUILDERS.has(name) || call?.kind !== 'call' || links.length !== 2) {
			this.#problems.add(located, 'not a call of a builder of the kit', `one of ${rootName}.${[...KIT_BUILDERS].join(`, ${rootName}.`)}(…)`)
			return null
		}
		const binding = this.#graph.binding(located.module, rootName)
		const app = binding.kind === 'const' && binding.init !== undefined ? this.#const(binding.module, binding.name, binding.init) : null
		if (app?.kind !== 'app') {
			return null
		}
		const callback = Object.hasOwn(KIT_CALLBACKS, name) ? KIT_CALLBACKS[name] : undefined
		const args = this.#arguments(located.module, call.node, scope, (position): Role => {
			if (callback === undefined || callback.position !== position) return null
			return callback.options ? { procedures: callbackKit(callback.kind) } : { callback: callbackKit(callback.kind) }
		})
		if (args === null) {
			return null
		}
		return name === 'contract' ? { kind: 'kit-contract', app, args, at: located } : { kind: 'builder', kit: 'app', name, args, at: located }
	}

	/**
	 * `defineVocabulary({ … })` returns the object's `app`, `dimensions`, `actions` and `roles`, and nothing else, so the
	 * reader reads that projection of an object literal and refuses any other argument.
	 */
	#vocabularyCall(located: Located, links: readonly Link[], scope: Scope): LiteralValue | null {
		const [call] = links
		const args = call?.kind === 'call' && links.length === 1 ? this.#arguments(located.module, call.node, scope, () => null) : null
		const [vocabulary] = args ?? []
		if (args === null || args.length !== 1 || vocabulary?.kind !== 'object') {
			this.#problems.add(located, 'defineVocabulary used other than as one call of one object', 'defineVocabulary({ app, dimensions, actions, roles })')
			return null
		}
		const entries = new Map<string, LiteralValue>()
		for (const section of VOCABULARY_SECTIONS) {
			const entry = vocabulary.entries.get(section)
			if (entry !== undefined) {
				entries.set(section, entry)
			}
		}
		return { kind: 'object', entries, at: vocabulary.at }
	}

	#contractCall(located: Located, links: readonly Link[], scope: Scope): LiteralValue | null {
		const [call] = links
		if (call?.kind !== 'call' || links.length !== 1) {
			this.#problems.add(located, 'defineContract used other than as one call', 'defineContract(vocabulary, (c) => ({ … }))')
			return null
		}
		const args = this.#arguments(located.module, call.node, scope, (position) => (position === 1 ? { callback: 'surface' } : null))
		return args === null ? null : { kind: 'contract', args, at: located }
	}

	/** `z.<factory>(…)` or `z.iso.<format>(…)`, then `.<method>(…)` links, each applied to a real zod schema. */
	#zodChain(located: Located, links: readonly Link[], scope: Scope): LiteralValue | null {
		const isIso = links[0]?.kind === 'member' && links[0].name === 'iso'
		const steps: { readonly name: string; readonly call: AstNode }[] = []
		for (let index = isIso ? 1 : 0; index < links.length; index += 2) {
			const member = links[index]
			const call = links[index + 1]
			if (member?.kind !== 'member' || member.name === undefined || call?.kind !== 'call') {
				this.#problems.add(located, 'a z chain other than z.<factory>(…).<method>(…)', 'a schema of the supported z subset (packages/check/CLAUDE.md)')
				return null
			}
			steps.push({ name: member.name, call: call.node })
		}
		let schema: z.ZodType | undefined
		let size: SchemaSize = { nodes: 0, depth: 0 }
		for (const [position, step] of steps.entries()) {
			const at = { module: located.module, node: step.call }
			const args = this.#arguments(located.module, step.call, scope, () => null)
			if (args === null) {
				return null
			}
			size = stepSize(position === 0 ? null : step.name, size, schemaParts(args))
			if (size.nodes > CONTRACT_LIMITS.schemaNodes || size.depth > CONTRACT_LIMITS.schemaDepth) {
				this.#problems.add(at, `the schema expands to ${size.nodes} nodes nested ${size.depth} deep`, schemaLimits())
				return null
			}
			const built = buildSchema(position === 0 ? { factory: step.name, iso: isIso } : { method: step.name, receiver: schema }, args)
			if (!built.ok) {
				this.#problems.add(at, built.message, built.allowed)
				return null
			}
			schema = built.schema
		}
		return schema === undefined ? null : { kind: 'schema', schema, nodes: size.nodes, depth: size.depth, at: located }
	}

	#arguments(module: ParsedModule, call: AstNode, scope: Scope, roleAt: (position: number) => Role): LiteralValue[] | null {
		const values: LiteralValue[] = []
		let complete = true
		for (const [position, argument] of children(call, 'arguments').entries()) {
			if (argument === null || argument.type === 'SpreadElement') {
				this.#problems.add({ module, node: argument ?? call }, 'spread', 'the arguments written out')
				complete = false
				continue
			}
			const value = this.#read({ module, node: argument }, scope, roleAt(position))
			if (value === null) {
				complete = false
			} else {
				values.push(value)
			}
		}
		return complete ? values : null
	}

	/** What an imported name builds, when it is one of the builders the platform reads. */
	#builderOf(module: ParsedModule, name: string): BuilderKind | undefined {
		const imported = this.#graph.index(module).imports.get(name)
		return imported === undefined ? undefined : BUILDER_IMPORTS[imported.specifier]?.[imported.imported]
	}
}

interface SchemaSize {
	readonly nodes: number
	readonly depth: number
}

export const schemaLimits = (): string =>
	`a schema within ${CONTRACT_LIMITS.schemaNodes} expanded nodes and ${CONTRACT_LIMITS.schemaDepth} levels (CONTRACT_LIMITS)`

/** The schemas among a step's arguments, through the arrays and objects that hold them, summed and at their deepest. */
const schemaParts = (values: readonly LiteralValue[]): SchemaSize => {
	let nodes = 0
	let depth = 0
	const pending = [...values]
	for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
		if (value.kind === 'schema') {
			nodes += value.nodes
			depth = Math.max(depth, value.depth)
		} else if (value.kind === 'array') {
			pending.push(...value.items)
		} else if (value.kind === 'object') {
			pending.push(...value.entries.values())
		}
	}
	return { nodes, depth }
}

/** Methods whose result holds the schema they are called on as one more level. */
const WRAPPING_METHODS = new Set(['optional', 'nullable', 'nullish', 'default', 'array', 'or'])

/**
 * The size after one step: a factory is one node above its argument schemas; a wrapping method one node above the
 * schema and its argument; `extend` and friends merge shapes; a check adds no node.
 */
const stepSize = (method: string | null, receiver: SchemaSize, parts: SchemaSize): SchemaSize => {
	if (method === null) {
		return { nodes: parts.nodes + 1, depth: parts.depth + 1 }
	}
	if (WRAPPING_METHODS.has(method)) {
		return { nodes: receiver.nodes + parts.nodes + 1, depth: Math.max(receiver.depth, parts.depth) + 1 }
	}
	return { nodes: receiver.nodes + parts.nodes, depth: Math.max(receiver.depth, parts.depth) }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null

const templateCooked = (element: AstNode): string | undefined => {
	const value = element['value']
	return isRecord(value) && typeof value['cooked'] === 'string' ? value['cooked'] : undefined
}

const compile = (pattern: string, flags: string): RegExp | undefined => {
	try {
		return new RegExp(pattern, flags)
	} catch {
		return undefined
	}
}

/** The name of a value kind, for a problem that names what was expected. */
export const describeKind = (
	value: LiteralValue,
): string => (value.kind === 'builder' ? `${kitName(value.kit)}.${value.name}(…)` : value.kind === 'kit-contract' ? 'app.contract(…)' : value.kind)
