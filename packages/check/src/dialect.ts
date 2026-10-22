import { child, identifierName, parseModule } from './ast'
import { ModuleGraph, unwrapValue } from './graph'
import { CONFIG_FILE } from './layout'

/** The database an application's data layer runs on: SQLite in its Durable Object on Cloudflare (ADR-0065), else Postgres. */
export type ApplicationDialect = 'postgres' | 'sqlite'

const CLOUDFLARE_PROVIDER = '@fabrika/provider-cloudflare'

/**
 * Read statically from `fabrika.config.ts`: SQLite when its default export is a call of the `defineApp` that
 * `@fabrika/provider-cloudflare` exports, the config every Cloudflare application writes. Postgres otherwise,
 * including without a config or when the call's origin is not static.
 */
export const applicationDialect = (files: ReadonlyMap<string, string>): ApplicationDialect => {
	const text = files.get(CONFIG_FILE)
	if (text === undefined) return 'postgres'
	const parsed = parseModule(CONFIG_FILE, text)
	if (!parsed.ok) return 'postgres'
	const graph = new ModuleGraph(new Map([[CONFIG_FILE, parsed.module]]))
	const exported = graph.exported(parsed.module, 'default')
	if (exported.kind !== 'default') return 'postgres'
	const call = unwrapValue(exported.expression)
	if (call.type !== 'CallExpression') return 'postgres'
	const callee = identifierName(child(call, 'callee'))
	if (callee === undefined) return 'postgres'
	const binding = graph.binding(parsed.module, callee)
	return binding.kind === 'package' && binding.specifier === CLOUDFLARE_PROVIDER && binding.imported === 'defineApp' ? 'sqlite' : 'postgres'
}
