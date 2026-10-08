// Reads `src/db/tables.ts` into table policies without executing it: the two arguments of
// `defineTables<DB, Action>(columns)({ … })` are read as literals, then parsed by `@fabrika/db`'s own policy parse.

import { PolicyError, readTables, type TablePolicies, tablePolicies } from '@fabrika/db/tables'
import { children, identifierName } from '../ast'
import type { Located, ModuleGraph } from '../graph'
import { TABLES_EXPORT, TABLES_FILE } from '../layout'
import { BUILDER_IMPORTS, decompose } from '../rules/literal'
import type { ReaderProblems } from './problems'
import { type LiteralValue, ValueReader } from './value'

const ALLOWED_CALL = `export const ${TABLES_EXPORT} = defineTables<DB, Action>(columns)({ … })`
const ALLOWED_POLICY = 'a table policy defineTables accepts (packages/db/CLAUDE.md)'

/** The policies of `src/db/tables.ts`; none when the graph has no such module. `null` after recording why not. */
export function readTablesValue(graph: ModuleGraph, problems: ReaderProblems): TablePolicies | null {
	const module = graph.module(TABLES_FILE)
	if (module === undefined) {
		return {}
	}
	const binding = graph.exported(module, TABLES_EXPORT)
	if (binding.kind !== 'const' || binding.init === undefined) {
		problems.add({ module, node: module.program }, `${TABLES_FILE} exports no const '${TABLES_EXPORT}'`, ALLOWED_CALL)
		return null
	}
	const at: Located = { module: binding.module, node: binding.init }
	const { root, links } = decompose(binding.init)
	const imported = graph.index(binding.module).imports.get(identifierName(root) ?? '')
	const builder = imported === undefined ? undefined : BUILDER_IMPORTS[imported.specifier]?.[imported.imported]
	const [first, second] = links
	const columnsNode = first?.kind === 'call' ? soleArgument(first.node) : undefined
	const policiesNode = second?.kind === 'call' ? soleArgument(second.node) : undefined
	if (builder !== 'tables' || links.length !== 2 || columnsNode === undefined || policiesNode === undefined) {
		problems.add(at, `'${TABLES_EXPORT}' is not one call of defineTables with the column list, then the policies`, ALLOWED_CALL)
		return null
	}
	const reader = new ValueReader(graph, problems)
	const columns = reader.value({ module: binding.module, node: columnsNode })
	const policies = reader.value({ module: binding.module, node: policiesNode })
	const plainColumns = columns === null ? undefined : plainOf(columns, problems)
	const plainPolicies = policies === null ? undefined : plainOf(policies, problems)
	if (plainColumns === undefined || plainPolicies === undefined) {
		return null
	}
	try {
		return tablePolicies(readTables(plainColumns, plainPolicies))
	} catch (error) {
		if (!(error instanceof PolicyError)) {
			throw error
		}
		problems.add(at, error.message, ALLOWED_POLICY)
		return null
	}
}

function soleArgument(call: Located['node']): Located['node'] | undefined {
	const args = children(call, 'arguments')
	const [only] = args
	return args.length === 1 && only !== null && only !== undefined && only.type !== 'SpreadElement' ? only : undefined
}

/** The value as `defineTables` would receive it at runtime; `undefined` after recording a value it cannot hold. */
function plainOf(value: LiteralValue, problems: ReaderProblems): unknown {
	switch (value.kind) {
		case 'string':
		case 'number':
		case 'boolean':
			return value.value
		case 'null':
			return null
		case 'array': {
			const items: unknown[] = []
			for (const item of value.items) {
				const plain = plainOf(item, problems)
				if (plain === undefined) {
					return undefined
				}
				items.push(plain)
			}
			return items
		}
		case 'object': {
			const entries: [string, unknown][] = []
			for (const [key, entry] of value.entries) {
				const plain = plainOf(entry, problems)
				if (plain === undefined) {
					return undefined
				}
				entries.push([key, plain])
			}
			return Object.fromEntries(entries)
		}
		default:
			problems.add(value.at, `a ${value.kind} in a table policy`, 'strings, arrays and objects of them')
			return undefined
	}
}
