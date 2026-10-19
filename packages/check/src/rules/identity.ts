import { type AstNode, child, children, type ParsedModule, staticKey, walk } from '../ast'
import { type Finding, reporter } from '../finding'
import { type Located, type ModuleGraph, propertyValue } from '../graph'

const IDENTITY_FIELDS = new Set([
	'userId',
	'ownerId',
	'createdBy',
	'tenantId',
	'workspaceId',
	'user_id',
	'owner_id',
	'created_by',
	'tenant_id',
	'workspace_id',
])
/** The contract builders whose options carry an `input`. */
const ENDPOINT_BUILDERS = new Set(['query', 'mutation', 'webhook'])
const SHAPE_METHODS = new Set(['object', 'strictObject', 'looseObject', 'extend', 'safeExtend'])
const MERGE_METHODS = new Set(['merge', 'and'])

/** The top-level field names of a zod object schema, through consts, imports, `.extend()` and `.merge()`. */
const schemaFields = (located: Located, graph: ModuleGraph, depth = 0): ReadonlySet<string> => {
	const fields = new Set<string>()
	const value = depth > 16 ? undefined : graph.resolveValue(located)
	const callee = value?.node.type === 'CallExpression' ? child(value.node, 'callee') : undefined
	if (value === undefined || callee?.type !== 'MemberExpression') return fields
	const add = (from: Located) => {
		for (const field of schemaFields(from, graph, depth + 1)) fields.add(field)
	}
	const receiver = child(callee, 'object')
	if (receiver !== undefined) add({ module: value.module, node: receiver })
	const method = staticKey(callee, 'property')
	const argument = children(value.node, 'arguments')[0]
	if (method === undefined || !argument) return fields
	if (SHAPE_METHODS.has(method)) {
		const shape = graph.resolveValue({ module: value.module, node: argument })
		for (const property of shape?.node.type === 'ObjectExpression' ? children(shape.node, 'properties') : []) {
			const key = property === null ? undefined : staticKey(property, 'key')
			if (key !== undefined) fields.add(key)
		}
	} else if (MERGE_METHODS.has(method)) add({ module: value.module, node: argument })
	return fields
}

/** The field an `in`/`on` access form takes from the input; the framework removes it and checks the caller's access to it. */
const checkedField = (access: Located | undefined, graph: ModuleGraph): string | undefined => {
	const value = access === undefined ? undefined : graph.resolveValue(access)
	if (value === undefined || (propertyValue(value, 'in') === undefined && propertyValue(value, 'on') === undefined)) return undefined
	const from = propertyValue(value, 'from')
	return from === undefined ? undefined : graph.resolveString(from)
}

/** Endpoint inputs that carry the caller's identity or tenant, outside the `in`/`on` form that checks it. */
export const checkClientIdentity = (contract: ParsedModule, graph: ModuleGraph): Finding[] => {
	const findings: Finding[] = []
	const report = reporter(contract.file, findings)
	walk(contract.program, (node) => {
		const callee = node.type === 'CallExpression' ? child(node, 'callee') : undefined
		if (callee?.type !== 'MemberExpression' || !ENDPOINT_BUILDERS.has(staticKey(callee, 'property') ?? '')) return
		for (const argument of children(node, 'arguments')) {
			if (argument === null) continue
			const options = graph.resolveValue({ module: contract, node: argument })
			const input = options === undefined ? undefined : propertyValue(options, 'input')
			if (options === undefined || input === undefined) continue
			const checked = checkedField(propertyValue(options, 'access'), graph)
			const at: AstNode = input.module === contract ? input.node : argument
			for (const field of schemaFields(input, graph)) {
				if (!IDENTITY_FIELDS.has(field) || field === checked) continue
				report(
					at,
					'client-identity',
					`input field '${field}' trusts the client to say who it is or which tenant it acts in`,
					`access { action, in: '<dimension>', from: '${field}' } or { action, on: … }, or the value from ctx`,
				)
			}
		}
	})
	return findings
}
