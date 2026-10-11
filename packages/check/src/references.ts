import { type AstNode, child, children, identifierName, memberPath, staticKey, staticString, stringField, walk } from './ast'

/**
 * One way a module names another: a static import, a re-export, a dynamic `import()`, `require()` (also `module.require`
 * and `import.meta.require`) or `import x = require()`.
 */
export interface ModuleReference {
	readonly specifier: string
	readonly node: AstNode
	/** The names taken from the module: imported or re-exported names, `default`, or `*` for the whole module. */
	readonly names: readonly string[]
	/** Erased at compile time: `import type`, or a declaration whose every specifier is `type`. */
	readonly typeOnly: boolean
}

const specifierName = (specifier: AstNode, key: 'imported' | 'local'): string => {
	if (specifier.type === 'ImportDefaultSpecifier') return 'default'
	if (specifier.type === 'ImportNamespaceSpecifier') return '*'
	const name = child(specifier, key)
	return identifierName(name) ?? staticString(name) ?? ''
}

/** A declaration with a specifier list: `import { a, type b } from 'x'`, `export { a, type b } from 'x'`. */
const listReference = (node: AstNode, kindField: 'importKind' | 'exportKind', nameKey: 'imported' | 'local'): ModuleReference | undefined => {
	const specifier = staticString(child(node, 'source'))
	if (specifier === undefined) return undefined
	const specifiers = children(node, 'specifiers').filter((item): item is AstNode => item !== null)
	const values = specifiers.filter((item) => stringField(item, kindField) !== 'type')
	const typeOnly = stringField(node, kindField) === 'type' || (specifiers.length > 0 && values.length === 0)
	return { specifier, node, names: typeOnly ? [] : values.map((item) => specifierName(item, nameKey)), typeOnly }
}

/** What a direct load takes: `require('x').a` → `a`; `const { a } = await import('x')` → `a`; anything else the whole module. */
const loadedNames = (load: AstNode, ancestors: readonly AstNode[]): readonly string[] => {
	let value = load
	let depth = ancestors.length - 1
	let parent = ancestors[depth]
	if (parent?.type === 'AwaitExpression' && parent['argument'] === load) {
		value = parent
		depth--
		parent = ancestors[depth]
	}
	if (parent?.type === 'MemberExpression' && parent['object'] === value) return [staticKey(parent, 'property') ?? '*']
	const pattern = parent?.type === 'VariableDeclarator' && parent['init'] === value ? child(parent, 'id') : undefined
	if (pattern?.type !== 'ObjectPattern') return ['*']
	return children(pattern, 'properties').map((property) => (property?.type === 'Property' ? (staticKey(property, 'key') ?? '*') : '*'))
}

export const isRequire = (callee: AstNode | undefined): boolean => {
	if (callee === undefined) return false
	const path = memberPath(callee)
	if (path?.length === 1) return path[0] === 'require'
	return path?.length === 2 && (path[0] === 'module' || path[0] === 'import.meta') && path[1] === 'require'
}

const referenceOf = (node: AstNode, ancestors: readonly AstNode[]): ModuleReference | undefined => {
	switch (node.type) {
		case 'ImportDeclaration':
			return listReference(node, 'importKind', 'imported')
		case 'ExportNamedDeclaration':
			return listReference(node, 'exportKind', 'local')
		case 'ExportAllDeclaration': {
			const specifier = staticString(child(node, 'source'))
			const typeOnly = stringField(node, 'exportKind') === 'type'
			return specifier === undefined ? undefined : { specifier, node, names: typeOnly ? [] : ['*'], typeOnly }
		}
		case 'ImportExpression': {
			const specifier = staticString(child(node, 'source'))
			return specifier === undefined ? undefined : { specifier, node, names: loadedNames(node, ancestors), typeOnly: false }
		}
		case 'CallExpression': {
			if (!isRequire(child(node, 'callee'))) return undefined
			const specifier = staticString(children(node, 'arguments')[0] ?? undefined)
			return specifier === undefined ? undefined : { specifier, node, names: loadedNames(node, ancestors), typeOnly: false }
		}
		case 'TSImportEqualsDeclaration': {
			const reference = child(node, 'moduleReference')
			if (reference?.type !== 'TSExternalModuleReference') return undefined
			const specifier = staticString(child(reference, 'expression'))
			const typeOnly = stringField(node, 'importKind') === 'type'
			return specifier === undefined ? undefined : { specifier, node, names: typeOnly ? [] : ['*'], typeOnly }
		}
		default:
			return undefined
	}
}

export const moduleReferences = (program: AstNode): readonly ModuleReference[] => {
	const references: ModuleReference[] = []
	walk(program, (node, ancestors) => {
		const reference = referenceOf(node, ancestors)
		if (reference !== undefined) references.push(reference)
	})
	return references
}
