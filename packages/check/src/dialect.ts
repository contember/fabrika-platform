import { type AstNode, child, children, identifierName, type ParsedModule, parseModule, staticKey, stringField } from './ast'
import { type Located, ModuleGraph, unwrapValue } from './graph'
import { CONFIG_FILE } from './layout'

/** The database an application's data layer runs on: SQLite in its Durable Object on Cloudflare (ADR-0065), else Postgres. */
export type ApplicationDialect = 'postgres' | 'sqlite'

const CLOUDFLARE_PROVIDER = '@fabrika/provider-cloudflare'

/**
 * The shape of a Postgres choice the static read settles, named by every refusal that sends an author to it: the checker,
 * the CLI and the deployer.
 */
export const READABLE_DATABASE_SHAPE =
	"`export default defineApp({ …, database: { kind: 'postgres', provisioningSecret: '<SECRET>' } })`, its argument an object literal (directly or through a `const`) with no spread of a value the read cannot follow"

/** What `fabrika.config.ts` says, read statically, about where an application runs and the database it runs on. */
export interface ApplicationTarget {
	/** The default export is @fabrika/provider-cloudflare's defineApp. */
	readonly cloudflare: boolean
	/**
	 * postgres for every non-Cloudflare application and for a Cloudflare one whose defineApp argument states
	 * database: { kind: 'postgres', … }; sqlite otherwise.
	 */
	readonly dialect: ApplicationDialect
	/**
	 * A Cloudflare config that names `database` in a form the static read cannot settle (no object literal, a spread in
	 * it, a kind other than the literal 'postgres'). A refusal: the config names a database the read cannot see.
	 */
	readonly unreadable?: string
	/**
	 * A Cloudflare config whose defineApp argument the read cannot follow to its end (no static object literal, or a
	 * spread of a value it cannot read), so it cannot tell whether it names `database` at all. Not a refusal: it reads as
	 * SQLite, and what loads the config (the CLI, the deployer) refuses it when the loaded config names a database.
	 */
	readonly unsettled?: string
}

const NOT_CLOUDFLARE: ApplicationTarget = { cloudflare: false, dialect: 'postgres' }

/** The `database` property of an argument, followed through spreads of object literals; the last one wins. */
type DatabaseProperty =
	| { readonly kind: 'absent' }
	| { readonly kind: 'found'; readonly located: Located }
	| { readonly kind: 'unsettled'; readonly reason: string }

const MAX_SPREAD_DEPTH = 16

/**
 * Read statically from `fabrika.config.ts`. A Cloudflare application is one whose default export is a call of the
 * `defineApp` that `@fabrika/provider-cloudflare` exports (by name or through a namespace import), followed through
 * `const` bindings, the config every Cloudflare application writes; it runs on its Durable Object's SQLite (ADR-0065)
 * unless the call's argument states `database: { kind: 'postgres', … }`. The argument, its spreads and the `database`
 * value are followed through `const` bindings to object literals. Postgres otherwise, including without a config or when
 * the call's origin is not static. What the read cannot follow is `unsettled`, and a `database` it sees but cannot read
 * is `unreadable`.
 */
export const applicationTarget = (files: ReadonlyMap<string, string>): ApplicationTarget => {
	const text = files.get(CONFIG_FILE)
	if (text === undefined) return NOT_CLOUDFLARE
	const parsed = parseModule(CONFIG_FILE, text)
	if (!parsed.ok) return NOT_CLOUDFLARE
	const graph = new ModuleGraph(new Map([[CONFIG_FILE, parsed.module]]))
	const call = defaultExport(graph, parsed.module)
	if (call === undefined || call.node.type !== 'CallExpression' || !isCloudflareDefineApp(graph, call.module, child(call.node, 'callee'))) {
		return NOT_CLOUDFLARE
	}
	const argument = children(call.node, 'arguments')[0]
	if (argument === undefined || argument === null) return { cloudflare: true, dialect: 'sqlite' }
	const database = databaseProperty(graph, { module: call.module, node: argument }, 0)
	if (database.kind === 'absent') return { cloudflare: true, dialect: 'sqlite' }
	if (database.kind === 'unsettled') return { cloudflare: true, dialect: 'sqlite', unsettled: database.reason }
	const kind = postgresKind(graph, database.located)
	return kind === null
		? { cloudflare: true, dialect: 'postgres' }
		: { cloudflare: true, dialect: 'sqlite', unreadable: `\`database\` ${kind}; write it as ${READABLE_DATABASE_SHAPE}` }
}

/** The expression the default export is written as, followed through `const` bindings. */
const defaultExport = (graph: ModuleGraph, module: ParsedModule): Located | undefined => {
	const exported = graph.exported(module, 'default')
	if (exported.kind === 'default') return graph.resolveValue({ module: exported.module, node: exported.expression })
	if (exported.kind === 'const' && exported.init !== undefined) return graph.resolveValue({ module: exported.module, node: exported.init })
	return undefined
}

/** `defineApp` or `<namespace>.defineApp` of @fabrika/provider-cloudflare. */
const isCloudflareDefineApp = (graph: ModuleGraph, module: ParsedModule, callee: AstNode | undefined): boolean => {
	if (callee === undefined) return false
	const node = unwrapValue(callee)
	const name = identifierName(node)
	if (name !== undefined) {
		const binding = graph.binding(module, name)
		return binding.kind === 'package' && binding.specifier === CLOUDFLARE_PROVIDER && binding.imported === 'defineApp'
	}
	if (node.type !== 'MemberExpression' || node['optional'] === true || staticKey(node, 'property') !== 'defineApp') return false
	const namespace = identifierName(child(node, 'object'))
	if (namespace === undefined) return false
	const binding = graph.binding(module, namespace)
	return binding.kind === 'package' && binding.specifier === CLOUDFLARE_PROVIDER && binding.imported === '*'
}

/** The `database` property an object value names, through `const` bindings and spreads of object literals. */
const databaseProperty = (graph: ModuleGraph, value: Located, depth: number): DatabaseProperty => {
	const object = graph.resolveValue(value)
	if (object === undefined || object.node.type !== 'ObjectExpression') {
		return { kind: 'unsettled', reason: 'its argument is no object literal the read can follow' }
	}
	let found: DatabaseProperty = { kind: 'absent' }
	for (const property of children(object.node, 'properties')) {
		if (property === null) continue
		if (property.type === 'SpreadElement') {
			const spread = child(property, 'argument')
			const inner: DatabaseProperty = spread === undefined || depth >= MAX_SPREAD_DEPTH
				? { kind: 'unsettled', reason: 'it spreads a value the read cannot follow' }
				: databaseProperty(graph, { module: object.module, node: spread }, depth + 1)
			if (inner.kind === 'unsettled') found = { kind: 'unsettled', reason: 'it spreads a value the read cannot follow' }
			else if (inner.kind === 'found') found = inner
			continue
		}
		if (property.type === 'Property' && staticKey(property, 'key') === 'database') {
			found = { kind: 'found', located: { module: object.module, node: property } }
		}
	}
	return found
}

/** The property `key` of an object literal holds: the last one of that name. */
const lastProperty = (object: AstNode, key: string): AstNode | undefined => {
	let found: AstNode | undefined
	for (const property of children(object, 'properties')) {
		if (property?.type === 'Property' && staticKey(property, 'key') === key) found = property
	}
	return found
}

/** `null` when the `database` property states `{ kind: 'postgres', … }`, else why the read cannot settle it. */
const postgresKind = (graph: ModuleGraph, located: Located): string | null => {
	const property = located.node
	const value = child(property, 'value')
	if (property['method'] === true || stringField(property, 'kind') !== 'init' || value === undefined) return 'is not an object literal'
	const database = graph.resolveValue({ module: located.module, node: value })
	if (database === undefined || database.node.type !== 'ObjectExpression') return 'is not an object literal'
	const properties = children(database.node, 'properties')
	if (properties.some((item) => item?.type !== 'Property')) return 'spreads another object'
	const kind = lastProperty(database.node, 'kind')
	const named = kind === undefined ? undefined : child(kind, 'value')
	if (named === undefined) return 'names no `kind`'
	return graph.resolveString({ module: database.module, node: named }) === 'postgres' ? null : "states a `kind` other than the literal 'postgres'"
}

/** The database an application's data layer runs on, read statically from `fabrika.config.ts` (`applicationTarget`). */
export const applicationDialect = (files: ReadonlyMap<string, string>): ApplicationDialect => applicationTarget(files).dialect
