import { type AstNode, child, children, identifierName, memberPath, staticString, stringField, unwrap, walk } from '../ast'
import type { Report } from '../finding'
import { isRequire } from '../references'
import { type ImportMappings, mappedTargets } from '../resolution'
import { declaringScope } from '../scope'
import { touchesPrototype } from './runtime'

const ALLOWED = 'framework objects are read-only: use them as they are'

/** The packages the platform trusts by name (`package-replacement`): their objects are the framework's. */
const isTrusted = (specifier: string): boolean => specifier.startsWith('@fabrika/') || specifier === 'zod' || specifier.startsWith('zod/')

/** One name bound to a trusted package's value, in the scope that declares it. */
interface TrustedBinding {
	readonly specifier: string
	readonly scope: AstNode | undefined
}

/** Local name → each declaration of it that holds a trusted package's value. */
export type TrustedBindings = ReadonlyMap<string, readonly TrustedBinding[]>

/** The trusted package a specifier loads, also through a package import map (`#data` → `@fabrika/db`). */
const trustedPackage = (specifier: string | undefined, mappings: ImportMappings): string | undefined => {
	if (specifier === undefined) return undefined
	const targets = mappedTargets(mappings, specifier) ?? [specifier]
	return targets.find(isTrusted)
}

const loadedSpecifier = (init: AstNode | undefined): string | undefined => {
	const value = init === undefined ? undefined : unwrap(init)
	const load = value?.type === 'AwaitExpression' ? child(value, 'argument') : value
	if (load?.type === 'ImportExpression') return staticString(child(load, 'source'))
	if (load?.type === 'CallExpression' && isRequire(child(load, 'callee'))) return staticString(children(load, 'arguments')[0] ?? undefined)
	return undefined
}

/** The names a declarator binds: `x`, or the values of `{ a, b: c }`. */
const boundNames = (pattern: AstNode | undefined): readonly string[] => {
	const name = identifierName(pattern)
	if (name !== undefined) return [name]
	if (pattern?.type !== 'ObjectPattern') return []
	return children(pattern, 'properties').flatMap((property) => {
		const value = property?.type === 'Property' ? identifierName(child(property, 'value')) : undefined
		return value === undefined ? [] : [value]
	})
}

/** What a module binds to a trusted package's values: its imports, `import x = require()`, and direct loads into a `const`. */
export const trustedBindings = (program: AstNode, mappings: ImportMappings): TrustedBindings => {
	const bindings = new Map<string, TrustedBinding[]>()
	const bind = (name: string, specifier: string, scope: AstNode | undefined): void => {
		bindings.set(name, [...(bindings.get(name) ?? []), { specifier, scope }])
	}
	walk(program, (node, ancestors) => {
		if (node.type === 'ImportDeclaration' && stringField(node, 'importKind') !== 'type') {
			const specifier = trustedPackage(staticString(child(node, 'source')), mappings)
			if (specifier === undefined) return
			for (const item of children(node, 'specifiers')) {
				const local = item === null || stringField(item, 'importKind') === 'type' ? undefined : identifierName(child(item, 'local'))
				if (local !== undefined) bind(local, specifier, program)
			}
		} else if (node.type === 'TSImportEqualsDeclaration' && stringField(node, 'importKind') !== 'type') {
			const reference = child(node, 'moduleReference')
			const specifier = trustedPackage(
				reference?.type === 'TSExternalModuleReference' ? staticString(child(reference, 'expression')) : undefined,
				mappings,
			)
			const local = identifierName(child(node, 'id'))
			if (specifier !== undefined && local !== undefined) bind(local, specifier, program)
		} else if (node.type === 'VariableDeclarator') {
			const specifier = trustedPackage(loadedSpecifier(child(node, 'init')), mappings)
			if (specifier !== undefined) {
				for (const name of boundNames(child(node, 'id'))) bind(name, specifier, declaringScope(name, ancestors))
			}
		}
	})
	return bindings
}

/**
 * The trusted binding a member chain starts from (`Database.postgres`, `db['Database'].postgres` → `Database`, `db`),
 * when the name at `ancestors` denotes that declaration and no local that shadows it.
 */
const trustedRoot = (
	target: AstNode | null | undefined,
	ancestors: readonly AstNode[],
	bindings: TrustedBindings,
): { readonly name: string; readonly specifier: string } | undefined => {
	let current = target === null || target === undefined ? undefined : unwrap(target)
	while (current?.type === 'MemberExpression') {
		const object = child(current, 'object')
		current = object === undefined ? undefined : unwrap(object)
	}
	const name = identifierName(current)
	const declarations = name === undefined ? undefined : bindings.get(name)
	if (name === undefined || declarations === undefined) return undefined
	const scope = declaringScope(name, ancestors)
	const binding = declarations.find((declaration) => declaration.scope === scope)
	return binding === undefined ? undefined : { name, specifier: binding.specifier }
}

/** The member expressions an assignment writes, also inside a destructuring pattern. */
const writtenMembers = (target: AstNode | undefined): readonly AstNode[] => {
	if (target === undefined) return []
	const node = unwrap(target)
	switch (node.type) {
		case 'MemberExpression':
			return [node]
		case 'ObjectPattern':
			return children(node, 'properties').flatMap((property) =>
				property === null ? [] : writtenMembers(child(property, property.type === 'RestElement' ? 'argument' : 'value'))
			)
		case 'ArrayPattern':
			return children(node, 'elements').flatMap((element) => (element === null ? [] : writtenMembers(element)))
		case 'AssignmentPattern':
			return writtenMembers(child(node, 'left'))
		case 'RestElement':
			return writtenMembers(child(node, 'argument'))
		default:
			return []
	}
}

const WRITERS = new Set([
	'Object.defineProperty',
	'Object.defineProperties',
	'Object.assign',
	'Object.setPrototypeOf',
	'Reflect.set',
	'Reflect.defineProperty',
	'Reflect.deleteProperty',
	'Reflect.setPrototypeOf',
])

/**
 * A write to a member of a value from `@fabrika/*` or `zod`: an assignment, `delete`, `++`, or a writer call on it. A
 * replaced `Database.postgres` receives the database URL; a patched schema changes what the contract admits. A write
 * through a prototype is `prototype-assignment`'s. A local that shadows such a name is not one.
 */
export const checkFrameworkWrite = (node: AstNode, ancestors: readonly AstNode[], bindings: TrustedBindings, report: Report): void => {
	if (bindings.size === 0) return
	const found = (at: AstNode, target: AstNode | null | undefined, how: string): void => {
		if (touchesPrototype(target ?? undefined)) return
		const root = trustedRoot(target, ancestors, bindings)
		if (root === undefined) return
		const written = target === null || target === undefined ? undefined : memberPath(target)
		const name = written === undefined || written.length < 2 ? root.name : written.join('.')
		report(at, 'framework-write', `${how} ${name}, a value from '${root.specifier}'`, ALLOWED)
	}
	switch (node.type) {
		case 'AssignmentExpression':
			for (const member of writtenMembers(child(node, 'left'))) found(node, member, 'assigns to')
			return
		case 'UpdateExpression':
			for (const member of writtenMembers(child(node, 'argument'))) found(node, member, 'changes')
			return
		case 'UnaryExpression':
			if (node['operator'] === 'delete') {
				for (const member of writtenMembers(child(node, 'argument'))) found(node, member, 'deletes')
			}
			return
		case 'CallExpression': {
			const callee = child(node, 'callee')
			const path = callee === undefined ? undefined : memberPath(callee)?.join('.')
			if (path !== undefined && WRITERS.has(path)) {
				const target = children(node, 'arguments')[0]
				const key = children(node, 'arguments')[1]
				const member = key !== null && key !== undefined && path !== 'Object.assign' ? staticString(key) : undefined
				found(node, target, member === undefined ? `${path} writes to` : `${path} writes '${member}' of`)
			}
			return
		}
		default:
			return
	}
}
