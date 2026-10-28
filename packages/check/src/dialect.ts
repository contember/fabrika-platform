import { type AstNode, child, children, identifierName, parseModule, staticKey, staticString } from './ast'
import { ModuleGraph, unwrapValue } from './graph'
import { CONFIG_FILE } from './layout'

/** The database an application's data layer runs on: SQLite in its Durable Object on Cloudflare (ADR-0065), else Postgres. */
export type ApplicationDialect = 'postgres' | 'sqlite'

const CLOUDFLARE_PROVIDER = '@fabrika/provider-cloudflare'

/** What `fabrika.config.ts` says, read statically, about where an application runs and the database it runs on. */
export interface ApplicationTarget {
	/** The default export is @fabrika/provider-cloudflare's defineApp. */
	readonly cloudflare: boolean
	/**
	 * postgres for every non-Cloudflare application and for a Cloudflare one whose defineApp argument states
	 * database: { kind: 'postgres', … } as a literal; sqlite otherwise.
	 */
	readonly dialect: ApplicationDialect
	/**
	 * A Cloudflare config that names `database` in a form the static read cannot settle (not an inline object literal, a
	 * kind other than the literal 'postgres').
	 */
	readonly unreadable?: string
}

const NOT_CLOUDFLARE: ApplicationTarget = { cloudflare: false, dialect: 'postgres' }

/**
 * Read statically from `fabrika.config.ts`. A Cloudflare application is one whose default export is a call of the
 * `defineApp` that `@fabrika/provider-cloudflare` exports, the config every Cloudflare application writes; it runs on
 * its Durable Object's SQLite (ADR-0065) unless the call's object literal argument states
 * `database: { kind: 'postgres', … }` inline. Postgres otherwise, including without a config or when the call's origin
 * is not static. Only a `database` property the read sees is settled: a spread or an argument that is no object literal
 * reads as SQLite, and the deployer compares what the loaded config says with what Control approved.
 */
export const applicationTarget = (files: ReadonlyMap<string, string>): ApplicationTarget => {
	const text = files.get(CONFIG_FILE)
	if (text === undefined) return NOT_CLOUDFLARE
	const parsed = parseModule(CONFIG_FILE, text)
	if (!parsed.ok) return NOT_CLOUDFLARE
	const graph = new ModuleGraph(new Map([[CONFIG_FILE, parsed.module]]))
	const exported = graph.exported(parsed.module, 'default')
	if (exported.kind !== 'default') return NOT_CLOUDFLARE
	const call = unwrapValue(exported.expression)
	if (call.type !== 'CallExpression') return NOT_CLOUDFLARE
	const callee = identifierName(child(call, 'callee'))
	if (callee === undefined) return NOT_CLOUDFLARE
	const binding = graph.binding(parsed.module, callee)
	if (binding.kind !== 'package' || binding.specifier !== CLOUDFLARE_PROVIDER || binding.imported !== 'defineApp') return NOT_CLOUDFLARE
	const argument = children(call, 'arguments')[0]
	const config = argument === undefined || argument === null ? undefined : unwrapValue(argument)
	if (config?.type !== 'ObjectExpression') return { cloudflare: true, dialect: 'sqlite' }
	const database = lastProperty(config, 'database')
	if (database === undefined) return { cloudflare: true, dialect: 'sqlite' }
	const kind = postgresKind(database)
	return kind === null
		? { cloudflare: true, dialect: 'postgres' }
		: {
			cloudflare: true,
			dialect: 'sqlite',
			unreadable: `\`database\` ${kind}; write it inline: database: { kind: 'postgres', provisioningSecret: '<SECRET>' }`,
		}
}

/** The property `key` of an object literal holds: the last one of that name. */
const lastProperty = (object: AstNode, key: string): AstNode | undefined => {
	let found: AstNode | undefined
	for (const property of children(object, 'properties')) {
		if (property?.type === 'Property' && staticKey(property, 'key') === key) found = property
	}
	return found
}

/** `null` when the `database` property states `{ kind: 'postgres', … }` inline, else why the read cannot settle it. */
const postgresKind = (property: AstNode): string | null => {
	const value = child(property, 'value')
	if (property['method'] === true || property['shorthand'] === true || value === undefined) return 'is not an object literal'
	const database = unwrapValue(value)
	if (database.type !== 'ObjectExpression') return 'is not an object literal'
	const properties = children(database, 'properties')
	if (properties.some((item) => item?.type !== 'Property')) return 'spreads another object'
	const kind = lastProperty(database, 'kind')
	const named = kind === undefined ? undefined : child(kind, 'value')
	if (named === undefined) return 'names no `kind`'
	return staticString(unwrapValue(named)) === 'postgres' ? null : "states a `kind` other than the literal 'postgres'"
}

/** The database an application's data layer runs on, read statically from `fabrika.config.ts` (`applicationTarget`). */
export const applicationDialect = (files: ReadonlyMap<string, string>): ApplicationDialect => applicationTarget(files).dialect
