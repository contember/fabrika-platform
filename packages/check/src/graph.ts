import {
	type AstNode,
	child,
	children,
	identifierName,
	isConstAssertion,
	type ParsedModule,
	staticKey,
	staticString,
	stringField,
	unwrap,
} from './ast'
import { isRelativeSpecifier, joinRelative, resolutionCandidates } from './layout'

export interface Located {
	readonly module: ParsedModule
	readonly node: AstNode
}

export interface ImportBinding {
	readonly local: string
	readonly specifier: string
	/** `default`, `*` or the imported name. */
	readonly imported: string
	/** The specifier node, where a finding about this import is reported. */
	readonly node: AstNode
}

/** What a name denotes, followed through imports and exports to its declaration. */
export type Binding =
	| { readonly kind: 'const'; readonly module: ParsedModule; readonly name: string; readonly init: AstNode | undefined }
	| { readonly kind: 'default'; readonly module: ParsedModule; readonly expression: AstNode }
	| { readonly kind: 'package'; readonly specifier: string; readonly imported: string }
	| { readonly kind: 'other'; readonly module: ParsedModule; readonly name: string }
	| { readonly kind: 'unresolved'; readonly reason: string }

interface ModuleIndex {
	readonly consts: ReadonlyMap<string, AstNode | undefined>
	/** Top-level names that are not consts: `let`, `var`, functions, classes. */
	readonly others: ReadonlySet<string>
	readonly imports: ReadonlyMap<string, ImportBinding>
	/** Exported name → the local name it exports, or the default export's expression. */
	readonly exports: ReadonlyMap<string, string | AstNode>
}

const importedName = (specifier: AstNode): string => {
	if (specifier.type === 'ImportDefaultSpecifier') return 'default'
	if (specifier.type === 'ImportNamespaceSpecifier') return '*'
	const imported = child(specifier, 'imported')
	return identifierName(imported) ?? staticString(imported) ?? ''
}

const indexModule = (module: ParsedModule): ModuleIndex => {
	const consts = new Map<string, AstNode | undefined>()
	const others = new Set<string>()
	const imports = new Map<string, ImportBinding>()
	const exports = new Map<string, string | AstNode>()
	for (const statement of children(module.program, 'body')) {
		if (statement === null) continue
		if (statement.type === 'ImportDeclaration') {
			const specifier = staticString(child(statement, 'source')) ?? ''
			if (stringField(statement, 'importKind') === 'type') continue
			for (const item of children(statement, 'specifiers')) {
				const local = item ? identifierName(child(item, 'local')) : undefined
				if (item === null || local === undefined || stringField(item, 'importKind') === 'type') continue
				imports.set(local, { local, specifier, imported: importedName(item), node: item })
			}
			continue
		}
		if (statement.type === 'ExportDefaultDeclaration') {
			const declaration = child(statement, 'declaration')
			if (declaration !== undefined) exports.set('default', declaration)
			continue
		}
		const isExport = statement.type === 'ExportNamedDeclaration'
		if (isExport && child(statement, 'source') === undefined && stringField(statement, 'exportKind') !== 'type') {
			for (const item of children(statement, 'specifiers')) {
				if (item === null || stringField(item, 'exportKind') === 'type') continue
				const local = identifierName(child(item, 'local'))
				const exported = child(item, 'exported')
				const name = identifierName(exported) ?? staticString(exported)
				if (local !== undefined && name !== undefined) exports.set(name, local)
			}
		}
		const declaration = isExport ? child(statement, 'declaration') : statement
		if (declaration === undefined) continue
		const declared: string[] = []
		if (declaration.type === 'VariableDeclaration') {
			const isConst = stringField(declaration, 'kind') === 'const'
			for (const declarator of children(declaration, 'declarations')) {
				const name = declarator ? identifierName(child(declarator, 'id')) : undefined
				if (declarator === null || name === undefined) continue
				declared.push(name)
				if (isConst) consts.set(name, child(declarator, 'init'))
				else others.add(name)
			}
		} else {
			const name = identifierName(child(declaration, 'id'))
			if (name !== undefined && !declaration.type.startsWith('TS')) {
				declared.push(name)
				others.add(name)
			}
		}
		if (isExport) { for (const name of declared) exports.set(name, name) }
	}
	return { consts, others, imports, exports }
}

/** Erased wrappers: `x satisfies T`, `x as const`, parentheses. */
export const unwrapValue = (node: AstNode): AstNode => {
	let current = unwrap(node)
	while (current.type === 'TSSatisfiesExpression' || (current.type === 'TSAsExpression' && isConstAssertion(current))) {
		const inner = child(current, 'expression')
		if (inner === undefined) break
		current = unwrap(inner)
	}
	return current
}

/** The application's modules, read statically: what each name denotes, without executing anything. */
export class ModuleGraph {
	readonly #modules: ReadonlyMap<string, ParsedModule>
	readonly #indexes = new Map<string, ModuleIndex>()

	constructor(modules: ReadonlyMap<string, ParsedModule>) {
		this.#modules = modules
	}

	module(file: string): ParsedModule | undefined {
		return this.#modules.get(file)
	}

	index(module: ParsedModule): ModuleIndex {
		const cached = this.#indexes.get(module.file)
		if (cached !== undefined) return cached
		const index = indexModule(module)
		this.#indexes.set(module.file, index)
		return index
	}

	/** The checked module a relative specifier names. */
	resolve(from: string, specifier: string): ParsedModule | undefined {
		if (!isRelativeSpecifier(specifier)) return undefined
		const base = joinRelative(from, specifier)
		if (base === undefined) return undefined
		for (const candidate of resolutionCandidates(base)) {
			const module = this.#modules.get(candidate)
			if (module !== undefined) return module
		}
		return undefined
	}

	/** What `name` denotes in `module`; an import is followed to the exporting module's declaration. */
	binding(module: ParsedModule, name: string, seen: ReadonlySet<string> = new Set()): Binding {
		const key = `${module.file}#${name}`
		if (seen.has(key)) return { kind: 'unresolved', reason: `'${name}' is imported in a cycle` }
		const index = this.index(module)
		if (index.consts.has(name)) return { kind: 'const', module, name, init: index.consts.get(name) }
		if (index.others.has(name)) return { kind: 'other', module, name }
		const imported = index.imports.get(name)
		if (imported === undefined) return { kind: 'unresolved', reason: `'${name}' is not declared` }
		if (!isRelativeSpecifier(imported.specifier)) return { kind: 'package', specifier: imported.specifier, imported: imported.imported }
		const target = this.resolve(module.file, imported.specifier)
		if (target === undefined) return { kind: 'unresolved', reason: `unresolved module '${imported.specifier}'` }
		return this.exported(target, imported.imported, new Set([...seen, key]))
	}

	/** What an exported name of `module` denotes. */
	exported(module: ParsedModule, name: string, seen: ReadonlySet<string> = new Set()): Binding {
		const exported = this.index(module).exports.get(name)
		if (exported === undefined) return { kind: 'unresolved', reason: `'${module.file}' does not export '${name}'` }
		if (typeof exported !== 'string') return { kind: 'default', module, expression: exported }
		return this.binding(module, exported, seen)
	}

	/** Follows identifiers and erased wrappers to the expression a value is written as; `undefined` when it is not static. */
	resolveValue(located: Located, depth = 0): Located | undefined {
		const node = unwrapValue(located.node)
		const name = identifierName(node)
		if (name === undefined) return { module: located.module, node }
		if (depth > 32) return undefined
		const binding = this.binding(located.module, name)
		if (binding.kind === 'const' && binding.init !== undefined) return this.resolveValue({ module: binding.module, node: binding.init }, depth + 1)
		if (binding.kind === 'default') return this.resolveValue({ module: binding.module, node: binding.expression }, depth + 1)
		return undefined
	}

	/** The fixed string a value resolves to. */
	resolveString(located: Located): string | undefined {
		const value = this.resolveValue(located)
		return value === undefined ? undefined : staticString(value.node)
	}
}

/** The value of `key` in an object literal, read statically; spreads and computed keys are not followed. */
export const propertyValue = (located: Located, key: string): Located | undefined => {
	if (located.node.type !== 'ObjectExpression') return undefined
	for (const property of children(located.node, 'properties')) {
		if (property?.type !== 'Property' || staticKey(property, 'key') !== key) continue
		const value = child(property, 'value')
		return value === undefined ? undefined : { module: located.module, node: value }
	}
	return undefined
}
