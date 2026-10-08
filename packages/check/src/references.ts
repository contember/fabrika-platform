import { type AstNode, child, children, identifierName, stringField, stringLiteral, walk } from './ast'

/** One way a module names another: a static import, a re-export, a dynamic `import()`, `require()` or `import x = require()`. */
export interface ModuleReference {
	readonly specifier: string
	readonly node: AstNode
	/** The imported names, `default` and `*` included; empty for a side-effect import, a re-export or a dynamic load. */
	readonly names: readonly string[]
	/** Erased at compile time: `import type`, or a declaration whose every specifier is `type`. */
	readonly typeOnly: boolean
}

const importedName = (specifier: AstNode): string => {
	if (specifier.type === 'ImportDefaultSpecifier') return 'default'
	if (specifier.type === 'ImportNamespaceSpecifier') return '*'
	const imported = child(specifier, 'imported')
	return identifierName(imported) ?? stringLiteral(imported) ?? ''
}

const staticImport = (node: AstNode): ModuleReference | undefined => {
	const specifier = stringLiteral(child(node, 'source'))
	if (specifier === undefined) return undefined
	const specifiers = children(node, 'specifiers').filter((item): item is AstNode => item !== null)
	const valueSpecifiers = specifiers.filter((item) => stringField(item, 'importKind') !== 'type')
	const typeOnly = stringField(node, 'importKind') === 'type' || (specifiers.length > 0 && valueSpecifiers.length === 0)
	return { specifier, node, names: typeOnly ? [] : valueSpecifiers.map(importedName), typeOnly }
}

const referenceOf = (node: AstNode): ModuleReference | undefined => {
	switch (node.type) {
		case 'ImportDeclaration':
			return staticImport(node)
		case 'ExportNamedDeclaration':
		case 'ExportAllDeclaration': {
			const specifier = stringLiteral(child(node, 'source'))
			if (specifier === undefined) return undefined
			return { specifier, node, names: [], typeOnly: stringField(node, 'exportKind') === 'type' }
		}
		case 'ImportExpression': {
			const specifier = stringLiteral(child(node, 'source'))
			return specifier === undefined ? undefined : { specifier, node, names: [], typeOnly: false }
		}
		case 'CallExpression': {
			if (identifierName(child(node, 'callee')) !== 'require') return undefined
			const specifier = stringLiteral(children(node, 'arguments')[0] ?? undefined)
			return specifier === undefined ? undefined : { specifier, node, names: [], typeOnly: false }
		}
		case 'TSImportEqualsDeclaration': {
			const reference = child(node, 'moduleReference')
			if (reference?.type !== 'TSExternalModuleReference') return undefined
			const specifier = stringLiteral(child(reference, 'expression'))
			return specifier === undefined ? undefined : { specifier, node, names: [], typeOnly: stringField(node, 'importKind') === 'type' }
		}
		default:
			return undefined
	}
}

export const moduleReferences = (program: AstNode): readonly ModuleReference[] => {
	const references: ModuleReference[] = []
	walk(program, (node) => {
		const reference = referenceOf(node)
		if (reference !== undefined) references.push(reference)
	})
	return references
}
