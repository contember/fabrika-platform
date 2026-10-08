import { type AstNode, child, children, identifierName, type ParsedModule, staticKey, stringLiteral, unwrap, walk } from '../ast'
import { type Finding, reporter } from '../finding'
import { isRelativeSpecifier, joinRelative, resolutionCandidates } from '../layout'

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
const OBJECT_SCHEMAS = new Set(['object', 'strictObject', 'looseObject', 'extend', 'safeExtend'])
const MERGED_SCHEMAS = new Set(['merge', 'and'])

interface Located {
	readonly module: ParsedModule
	readonly node: AstNode
}

const topLevelConst = (module: ParsedModule, name: string): AstNode | undefined => {
	for (const statement of children(module.program, 'body')) {
		if (statement === null) continue
		const declaration = statement.type === 'ExportNamedDeclaration' ? child(statement, 'declaration') : statement
		if (declaration?.type !== 'VariableDeclaration') continue
		for (const declarator of children(declaration, 'declarations')) {
			if (declarator !== null && identifierName(child(declarator, 'id')) === name) return child(declarator, 'init')
		}
	}
	return undefined
}

const importOf = (module: ParsedModule, local: string): { readonly specifier: string; readonly imported: string } | undefined => {
	for (const statement of children(module.program, 'body')) {
		if (statement?.type !== 'ImportDeclaration') continue
		const specifier = stringLiteral(child(statement, 'source'))
		for (const item of children(statement, 'specifiers')) {
			if (item?.type !== 'ImportSpecifier' || identifierName(child(item, 'local')) !== local) continue
			const imported = child(item, 'imported')
			const name = identifierName(imported) ?? stringLiteral(imported)
			return specifier === undefined || name === undefined ? undefined : { specifier, imported: name }
		}
	}
	return undefined
}

/** The initializer an identifier names: a const of the same module, or one imported from a relative module. */
const resolveIdentifier = (module: ParsedModule, name: string, modules: ReadonlyMap<string, ParsedModule>, depth: number): Located | undefined => {
	if (depth > 16) return undefined
	const local = topLevelConst(module, name)
	if (local !== undefined) return { module, node: local }
	const imported = importOf(module, name)
	if (imported === undefined || !isRelativeSpecifier(imported.specifier)) return undefined
	const base = joinRelative(module.file, imported.specifier)
	const target = base === undefined ? undefined : resolutionCandidates(base).map((path) => modules.get(path)).find((found) => found !== undefined)
	return target === undefined ? undefined : resolveIdentifier(target, imported.imported, modules, depth + 1)
}

/** The top-level field names of a zod object schema, through consts, `.extend()` and `.merge()`. */
const schemaFields = (located: Located, modules: ReadonlyMap<string, ParsedModule>, depth = 0): ReadonlySet<string> => {
	const fields = new Set<string>()
	if (depth > 16) return fields
	const node = unwrap(located.node)
	const name = identifierName(node)
	if (name !== undefined) {
		const target = resolveIdentifier(located.module, name, modules, 0)
		return target === undefined ? fields : schemaFields(target, modules, depth + 1)
	}
	const callee = node.type === 'CallExpression' ? child(node, 'callee') : undefined
	if (callee?.type !== 'MemberExpression') return fields
	const receiver = child(callee, 'object')
	if (receiver !== undefined) {
		for (const field of schemaFields({ module: located.module, node: receiver }, modules, depth + 1)) fields.add(field)
	}
	const method = staticKey(callee, 'property')
	const argument = children(node, 'arguments')[0]
	if (method === undefined || !argument) return fields
	if (OBJECT_SCHEMAS.has(method) && argument.type === 'ObjectExpression') {
		for (const property of children(argument, 'properties')) {
			const key = property === null ? undefined : staticKey(property, 'key')
			if (key !== undefined) fields.add(key)
		}
	} else if (MERGED_SCHEMAS.has(method)) {
		for (const field of schemaFields({ module: located.module, node: argument }, modules, depth + 1)) fields.add(field)
	}
	return fields
}

/** The field an `in`/`on` access form takes from the input; the framework removes it and checks the caller's access to it. */
const accessField = (access: AstNode | undefined): string | undefined => {
	if (access?.type !== 'ObjectExpression') return undefined
	let from: string | undefined
	let scoped = false
	for (const property of children(access, 'properties')) {
		if (property === null) continue
		const key = staticKey(property, 'key')
		if (key === 'in' || key === 'on') scoped = true
		if (key === 'from') from = stringLiteral(child(property, 'value'))
	}
	return scoped ? from : undefined
}

/** Endpoint inputs that carry the caller's identity or tenant, outside the `in`/`on` form that checks it. */
export const checkClientIdentity = (contract: ParsedModule, modules: ReadonlyMap<string, ParsedModule>): Finding[] => {
	const findings: Finding[] = []
	const report = reporter(contract.file, findings)
	walk(contract.program, (node) => {
		if (node.type !== 'ObjectExpression') return
		let input: AstNode | undefined
		let access: AstNode | undefined
		for (const property of children(node, 'properties')) {
			if (property?.type !== 'Property') continue
			const key = staticKey(property, 'key')
			if (key === 'input') input = property
			if (key === 'access') access = child(property, 'value')
		}
		const value = input === undefined ? undefined : child(input, 'value')
		if (input === undefined || value === undefined) return
		const checked = accessField(access)
		for (const field of schemaFields({ module: contract, node: value }, modules)) {
			if (!IDENTITY_FIELDS.has(field) || field === checked) continue
			report(
				input,
				'client-identity',
				`input field '${field}' trusts the client to say who it is or which tenant it acts in`,
				`access { action, in: '<dimension>', from: '${field}' } or { action, on: … }, or the value from ctx`,
			)
		}
	})
	return findings
}
