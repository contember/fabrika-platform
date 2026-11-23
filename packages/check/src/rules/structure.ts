import { isBuiltin } from 'node:module'
import { type AstNode, child, children, identifierName, isValueReference, staticKey, staticString, stringField, unwrap, walk } from '../ast'
import { type Finding, type Report, reporter, STRUCTURE_HINT_RULE_IDS } from '../finding'
import {
	CONTRACT_FILE,
	DATABASE_DIR,
	isRelativeSpecifier,
	isSourceFile,
	isTestFile,
	isToolModule,
	resolveRelative,
	SCHEMAS_DIR,
	SCHEMAS_FILE,
	SHARED_DIR,
	SLICE_ENDPOINTS_FILE,
	SLICE_LOGIC_FILE,
	SLICE_QUERIES_FILE,
	SPA_DIR,
} from '../layout'
import type { ModuleReference } from '../references'
import { type ImportMappings, mappedTargets } from '../resolution'
import { declaringScope } from '../scope'
import { isTestKit } from './modules'

/** The rules of the application architecture (docs/reference/application-architecture.md): three refusals and the hints. */
export const STRUCTURE_RULE_IDS = ['spa-server-import', 'layer-import', 'shared-import', ...STRUCTURE_HINT_RULE_IDS] as const

type SlicePart = 'endpoints' | 'logic' | 'queries'

const SLICE_PARTS: ReadonlyMap<string, SlicePart> = new Map([
	[SLICE_ENDPOINTS_FILE, 'endpoints'],
	[SLICE_LOGIC_FILE, 'logic'],
	[SLICE_QUERIES_FILE, 'queries'],
])

/** Directories under `src/` the layout gives another role; every other `src/<name>/` is the slice `<name>`. */
const NOT_SLICES: ReadonlySet<string> = new Set([DATABASE_DIR, SCHEMAS_DIR, SHARED_DIR, 'src/__tests__/'])

/** The slice a file lies in: the directory `src/<slice>/` it is under. */
const sliceOf = (path: string): string | undefined => {
	const [root, name, ...rest] = path.split('/')
	if (root !== 'src' || name === undefined || rest.length === 0 || NOT_SLICES.has(`src/${name}/`)) return undefined
	return name
}

/** Which slice module a file is: `src/<slice>/endpoints.ts`, `logic.ts` or `queries.ts`. */
const slicePart = (path: string): SlicePart | undefined => {
	const segments = path.split('/')
	const name = segments[2]
	if (segments.length !== 3 || name === undefined || sliceOf(path) === undefined) return undefined
	return SLICE_PARTS.get(name)
}

/** Where a module sits in the architecture, which decides what it may import and call. */
export interface StructurePlace {
	readonly file: string
	readonly slice: string | undefined
	readonly part: SlicePart | undefined
	/** A test or the generated entrypoint: the structure hints do not apply to it. */
	readonly exempt: boolean
	/** A generated module (`isGeneratedModule`): the hints do not apply to it, the refusals do. */
	readonly generated: boolean
}

export const structurePlace = (file: string, isGeneratedEntry: boolean, generated: boolean): StructurePlace => ({
	file,
	slice: sliceOf(file),
	part: slicePart(file),
	exempt: isGeneratedEntry || isTestFile(file),
	generated,
})

/** What the structure rules read beyond one module: every module's references, and how Bun resolves them. */
export interface StructureGraph {
	readonly files: ReadonlyMap<string, string>
	readonly mappings: ImportMappings
	readonly referencesOf: (path: string) => readonly ModuleReference[]
	/** The shell graph: the modules the SPA build plugins load as their slices, without handlers. */
	readonly shellModules: ReadonlySet<string>
}

interface Targets {
	/** Application files the reference may load, relative to the root. */
	readonly files: readonly string[]
	/** Package specifiers it loads, after the application's import mappings. */
	readonly packages: readonly string[]
}

const resolvedFiles = (exists: (path: string) => boolean, fromFile: string, specifier: string): readonly string[] => {
	const resolution = resolveRelative(exists, fromFile, specifier)
	if (resolution.kind === 'file') return [resolution.path]
	return resolution.kind === 'missing' ? [] : resolution.paths
}

/** What a reference loads. An absolute or out-of-tree target is `unchecked-import`'s finding, so it loads nothing here. */
const referenceTargets = (graph: StructureGraph, file: string, specifier: string): Targets => {
	const exists = (path: string): boolean => graph.files.has(path)
	if (isRelativeSpecifier(specifier)) return { files: resolvedFiles(exists, file, specifier), packages: [] }
	if (specifier.startsWith('/') || /^file:/i.test(specifier)) return { files: [], packages: [] }
	const mapped = mappedTargets(graph.mappings, file, specifier)
	if (mapped === undefined) return { files: [], packages: [specifier] }
	// Mapped targets are relative to the root.
	const files = mapped.filter(isRelativeSpecifier).flatMap((target) => resolvedFiles(exists, 'package.json', target))
	const packages = mapped.filter((target) => !isRelativeSpecifier(target) && !target.startsWith('/'))
	return { files, packages }
}

/**
 * Everything a reference loads at runtime: its targets, and what the local modules among them load in turn, through
 * imports, re-exports and literal loads. Only modules `descend` accepts are followed; each is read once.
 */
const runtimeClosure = (graph: StructureGraph, start: Targets, descend: (path: string) => boolean): Targets => {
	const files = new Set(start.files)
	const packages = new Set(start.packages)
	const pending = start.files.filter(descend)
	const followed = new Set(pending)
	for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
		for (const reference of graph.referencesOf(path)) {
			if (reference.typeOnly) continue
			const targets = referenceTargets(graph, path, reference.specifier)
			for (const target of targets.packages) packages.add(target)
			for (const target of targets.files) {
				files.add(target)
				if (!followed.has(target) && descend(target)) {
					followed.add(target)
					pending.push(target)
				}
			}
		}
	}
	return { files: [...files], packages: [...packages] }
}

const isDataPackage = (specifier: string): boolean => specifier === '@fabrika/db' || specifier.startsWith('@fabrika/db/')

/** The framework modules logic and queries may import; the rest of `@fabrika/*` is the framework's own composition. */
const LAYER_PACKAGES: ReadonlySet<string> = new Set(['@fabrika/app', '@fabrika/app/schema', '@fabrika/db'])

/** The framework modules an SPA loads: the typed client, its React hooks, the component kit and its challenge widget. */
const SPA_PACKAGES: ReadonlySet<string> = new Set([
	'@fabrika/app/client',
	'@fabrika/app/react',
	'@fabrika/app/schema',
	'@fabrika/ui',
	'@fabrika/ui/challenge',
	'@fabrika/ui/styles.css',
	'@fabrika/ui/theme.css',
])

const SPA_ALLOWED =
	'@fabrika/app/client, @fabrika/app/react, @fabrika/app/schema, @fabrika/ui, @fabrika/ui/challenge, fabrika.contract.ts, the src/<slice>/endpoints.ts of a group fabrika.contract.ts mounts (for createGroupClient), src/schemas.ts, modules under src/shared/ and modules under web/; a type-only import of anything else'

const isSchemaModule = (path: string): boolean => path === SCHEMAS_FILE || path.startsWith(SCHEMAS_DIR)

const isSharedModule = (path: string): boolean => path.startsWith(SHARED_DIR)

/**
 * The application modules a bundle of the SPA may load. `fabrika.contract.ts` and a slice's `endpoints.ts` in the shell
 * graph (a group client's group) are loaded without their handlers; an `endpoints.ts` outside it would load whole. A
 * shared module is checked on its own (`checkSharedReference`), so it is not followed.
 */
const isSpaModule = (graph: StructureGraph, path: string): boolean =>
	path.startsWith(SPA_DIR) || path === CONTRACT_FILE || isSchemaModule(path) || isSharedModule(path) || !isSourceFile(path)
	|| (slicePart(path) === 'endpoints' && graph.shellModules.has(path))

/** A runtime package the browser has not: the framework's server side, Bun, and Node's builtins in either spelling. */
const isServerPackage = (specifier: string): boolean => specifier.startsWith('@fabrika/') ? !SPA_PACKAGES.has(specifier) : isBuiltin(specifier)

/** Names what `reference` loads, directly or through the local modules it loads. */
const viaMessage = (reference: ModuleReference, loaded: string, what: string, into: string): string =>
	loaded === reference.specifier ? `'${loaded}' is ${what}, imported by ${into}` : `'${reference.specifier}' loads ${what} ('${loaded}') into ${into}`

/** The SPA's own modules are checked one by one; a schema module it loads is followed, since nothing else checks it. */
const checkSpaReference = (graph: StructureGraph, reference: ModuleReference, targets: Targets, report: Report): void => {
	const reached = runtimeClosure(graph, targets, isSchemaModule)
	const server = reached.packages.find(isServerPackage) ?? reached.files.find((path) => !isSpaModule(graph, path))
	if (server !== undefined) report(reference.node, 'spa-server-import', viaMessage(reference, server, 'server code', 'the SPA'), SPA_ALLOWED)
}

/** The packages shared code loads, zod's schemas either way; everything else it needs is in other modules of `src/shared/`. */
const SHARED_PACKAGES: ReadonlySet<string> = new Set(['zod/v4', '@fabrika/app/schema'])

/** A shared module runs in the SPA and in every slice, so it loads nothing either side lacks. */
const checkSharedReference = (reference: ModuleReference, targets: Targets, report: Report): void => {
	const outside = targets.packages.find((specifier) => !SHARED_PACKAGES.has(specifier)) ?? targets.files.find((path) => !isSharedModule(path))
	if (outside === undefined) return
	report(
		reference.node,
		'shared-import',
		viaMessage(reference, outside, 'outside src/shared/', 'shared code'),
		'zod/v4, @fabrika/app/schema and other modules under src/shared/; a type-only import of anything else',
	)
}

const isLayerModule = (path: string): boolean => {
	const part = slicePart(path)
	return part === 'logic' || part === 'queries'
}

/** Another logic or queries module is checked on its own; every other local module is followed with this one's rule. */
const checkLayerReference = (graph: StructureGraph, place: StructurePlace, reference: ModuleReference, targets: Targets, report: Report): void => {
	const reached = runtimeClosure(graph, targets, (path) => !isLayerModule(path))
	// The test kits are `test-only-import`'s finding everywhere outside a test file.
	const internal = reached.packages.find((specifier) => specifier.startsWith('@fabrika/') && !LAYER_PACKAGES.has(specifier) && !isTestKit(specifier))
	if (internal === undefined) return
	report(
		reference.node,
		'layer-import',
		viaMessage(reference, internal, 'a framework module', place.part === 'logic' ? 'logic' : 'queries'),
		'@fabrika/app (its errors) and @fabrika/db only, also through a helper module; the handler in endpoints.ts uses the rest',
	)
}

const LOGIC_ALLOWED = 'logic over plain values: the handler in endpoints.ts reads through ctx.db or a function of queries.ts and passes the values in'

const checkLogicReference = (reference: ModuleReference, targets: Targets, report: Report): void => {
	const data = targets.packages.some(isDataPackage)
		|| targets.files.some((path) => path.startsWith(DATABASE_DIR) || slicePart(path) === 'queries')
	if (data) report(reference.node, 'logic-data-access', `'${reference.specifier}' is data access, imported by logic`, LOGIC_ALLOWED)
}

const checkSliceReference = (place: StructurePlace, reference: ModuleReference, targets: Targets, report: Report): void => {
	const other = targets.files.find((path) => slicePart(path) === 'queries' && sliceOf(path) !== place.slice)
	if (other === undefined) return
	report(
		reference.node,
		'cross-slice-queries',
		`'${reference.specifier}' is the queries module of the slice '${sliceOf(other)}'`,
		"a function in this slice's own queries.ts; share a rule through the other slice's logic.ts",
	)
}

/** A top-level function of a module: its local name, its declaration, and the node a finding points at. */
interface TopLevelFunction {
	readonly local: string
	readonly declaration: AstNode
	readonly at: AstNode
}

const isFunctionValue = (node: AstNode | undefined): boolean => {
	const value = node === undefined ? undefined : unwrap(node)
	return value?.type === 'ArrowFunctionExpression' || value?.type === 'FunctionExpression'
}

/** `function f() {}` and `const f = () => …` (or a function expression) at the top level, by local name. */
const topLevelFunctions = (statement: AstNode): readonly TopLevelFunction[] => {
	if (statement.type === 'FunctionDeclaration') {
		const id = child(statement, 'id')
		const local = identifierName(id)
		return local === undefined || id === undefined ? [] : [{ local, declaration: statement, at: id }]
	}
	if (statement.type !== 'VariableDeclaration') return []
	return children(statement, 'declarations').flatMap((declarator) => {
		const id = declarator === null ? undefined : child(declarator, 'id')
		const local = identifierName(id)
		if (declarator === null || id === undefined || local === undefined || !isFunctionValue(child(declarator, 'init'))) return []
		return [{ local, declaration: declarator, at: id }]
	})
}

/** The functions a module exports by name: `export function`, `export const f = () => …`, `export { f as g }` of one. */
const exportedFunctions = (program: AstNode): ReadonlyMap<string, TopLevelFunction> => {
	const statements = children(program, 'body').filter((statement): statement is AstNode => statement !== null)
	const declared = new Map<string, TopLevelFunction>()
	for (const statement of statements) {
		const declaration = statement.type === 'ExportNamedDeclaration' ? child(statement, 'declaration') : statement
		for (const fn of declaration === undefined ? [] : topLevelFunctions(declaration)) declared.set(fn.local, fn)
	}
	const exported = new Map<string, TopLevelFunction>()
	for (const statement of statements) {
		if (statement.type !== 'ExportNamedDeclaration' || stringField(statement, 'exportKind') === 'type') continue
		const declaration = child(statement, 'declaration')
		if (declaration !== undefined) {
			for (const fn of topLevelFunctions(declaration)) exported.set(fn.local, fn)
			continue
		}
		if (child(statement, 'source') !== undefined) continue
		for (const specifier of children(statement, 'specifiers')) {
			if (specifier === null || stringField(specifier, 'exportKind') === 'type') continue
			const fn = declared.get(identifierName(child(specifier, 'local')) ?? '')
			const name = identifierName(child(specifier, 'exported')) ?? staticString(child(specifier, 'exported'))
			if (fn !== undefined && name !== undefined) exported.set(name, { ...fn, at: specifier })
		}
	}
	return exported
}

/** Whether `node` is the name a declaration binds: `const f = …`, `function f() {}`. */
const isDeclaredName = (node: AstNode, parent: AstNode): boolean =>
	(parent.type === 'VariableDeclarator' || parent.type === 'FunctionDeclaration') && child(parent, 'id') === node

/** Which of the top-level functions (local name → declaration) the module's own code uses as a value, outside its own declaration. */
const usedWithin = (program: AstNode, declarations: ReadonlyMap<string, AstNode>): ReadonlySet<string> => {
	const used = new Set<string>()
	walk(program, (node, ancestors) => {
		const name = identifierName(node)
		const declaration = name === undefined ? undefined : declarations.get(name)
		const parent = ancestors.at(-1)
		if (name === undefined || declaration === undefined || parent === undefined || isDeclaredName(node, parent)) return
		if (!isValueReference(node, parent) || declaringScope(name, ancestors) !== program || ancestors.includes(declaration)) return
		used.add(name)
	})
	return used
}

/**
 * `single-slice-queries`: a function of `src/<a>/queries.ts` that exactly one other slice `src/<b>/` uses belongs in
 * `src/<b>/queries.ts`. A caller is any module but a test, and a use is a named import or re-export; a function
 * exported under two names is one function. A module outside every slice, and a whole-module load (`import *`,
 * `export *`) from another slice, which names no function, leave every function they reach where it is.
 */
export const checkSingleSliceQueries = (graph: StructureGraph, programs: ReadonlyMap<string, AstNode>): Finding[] => {
	// Who loads each queries module: the importer's slice (`undefined` outside every slice) and the names it takes.
	const loads = new Map<string, { readonly slice: string | undefined; readonly names: readonly string[] }[]>()
	for (const importer of programs.keys()) {
		if (isTestFile(importer)) continue
		for (const reference of graph.referencesOf(importer)) {
			if (reference.typeOnly) continue
			for (const target of referenceTargets(graph, importer, reference.specifier).files) {
				if (target === importer || slicePart(target) !== 'queries') continue
				const into = loads.get(target) ?? []
				into.push({ slice: sliceOf(importer), names: reference.names })
				loads.set(target, into)
			}
		}
	}
	const findings: Finding[] = []
	for (const [file, program] of programs) {
		const slice = sliceOf(file)
		if (slicePart(file) !== 'queries' || slice === undefined) continue
		const exported = exportedFunctions(program)
		// Each function's callers, by its local name: the slices that use it, and `unjudged` once a use names no slice.
		const callers = new Map([...exported.values()].map((fn) => [fn.local, { slices: new Set<string>(), unjudged: false }]))
		const use = (local: string | undefined, caller: string | undefined): void => {
			const entry = local === undefined ? undefined : callers.get(local)
			if (entry === undefined) return
			if (caller === undefined) entry.unjudged = true
			else entry.slices.add(caller)
		}
		const within = usedWithin(program, new Map([...exported.values()].map((fn) => [fn.local, fn.declaration])))
		for (const local of within) use(local, slice)
		for (const load of loads.get(file) ?? []) {
			if (load.names.includes('*')) {
				for (const local of callers.keys()) use(local, load.slice === slice ? slice : undefined)
			} else {
				for (const name of load.names) use(exported.get(name)?.local, load.slice)
			}
		}
		const report = reporter(file, findings)
		for (const [name, fn] of exported) {
			const entry = callers.get(fn.local)
			const [only, ...rest] = entry?.slices ?? []
			if (entry === undefined || entry.unjudged || only === undefined || rest.length > 0 || only === slice) continue
			report(
				fn.at,
				'single-slice-queries',
				`'${name}' of ${file} is used only by the slice '${only}'`,
				`the function in src/${only}/queries.ts, with the helpers only it uses; ${file} keeps what two or more slices use`,
			)
		}
	}
	return findings
}

/**
 * A `package.json` under `tools/` makes a tool a package, which a workspace or a `file:` dependency lets the application
 * load by its name, past `tool-import`, which judges the files an import resolves to.
 */
export const checkToolPackages = (paths: readonly string[]): Finding[] =>
	paths.filter((path) => isToolModule(path) && path.endsWith('/package.json')).map((path) => ({
		file: path,
		line: 1,
		column: 1,
		severity: 'refusal',
		rule: 'tool-import',
		message: `'${path}' makes a developer's tool a package, which the application could load by its name`,
		allowed: "tools/ without a package.json: a tool's dependencies go in the root package.json",
	}))

/** The architecture's rules over one module's imports, re-exports and loads, as Bun resolves them for that module. */
export const checkStructureReferences = (graph: StructureGraph, place: StructurePlace, report: Report): void => {
	for (const reference of graph.referencesOf(place.file)) {
		const targets = referenceTargets(graph, place.file, reference.specifier)
		if (reference.typeOnly) continue
		const tool = isToolModule(place.file) ? undefined : targets.files.find(isToolModule)
		if (tool !== undefined) {
			report(
				reference.node,
				'tool-import',
				`'${reference.specifier}' loads ${tool}, a developer's tool, which nothing outside tools/ loads`,
				'what the application and a tool share under src/ (pure code in src/shared/), imported by the tool',
			)
		}
		if (place.file.startsWith(SPA_DIR) && !place.exempt) checkSpaReference(graph, reference, targets, report)
		if (isSharedModule(place.file) && !place.exempt) checkSharedReference(reference, targets, report)
		if (isLayerModule(place.file)) checkLayerReference(graph, place, reference, targets, report)
		if (place.exempt || place.generated) continue
		if (place.part === 'logic') checkLogicReference(reference, targets, report)
		else if (place.slice !== undefined) checkSliceReference(place, reference, targets, report)
	}
}

/** The builders whose procedure takes a handler: `r.query(…).handle(…)`. */
const PROCEDURE_BUILDERS: ReadonlySet<string> = new Set(['query', 'mutation', 'cron', 'webhook', 'export'])

/** A `<x>.<builder>(…).handle(…)` call: the builder's name, its call (whose arguments hold the options) and `.handle`. */
export interface HandledProcedure {
	readonly builder: string
	readonly procedure: AstNode
	/** The `handle` property node, where a finding points. */
	readonly handle: AstNode
}

/** The procedure `node` hands a handler to, when `node` is `<x>.<builder>(…).handle(…)`. */
export const handledProcedure = (node: AstNode): HandledProcedure | undefined => {
	if (node.type !== 'CallExpression') return undefined
	const callee = child(node, 'callee')
	if (callee?.type !== 'MemberExpression' || staticKey(callee, 'property') !== 'handle') return undefined
	const procedure = child(callee, 'object')
	const builder = procedure?.type === 'CallExpression' ? child(procedure, 'callee') : undefined
	if (procedure === undefined || builder?.type !== 'MemberExpression') return undefined
	const name = staticKey(builder, 'property')
	const handle = child(callee, 'property')
	return name !== undefined && PROCEDURE_BUILDERS.has(name) && handle !== undefined ? { builder: name, procedure, handle } : undefined
}

/** `ctx.db` or `ctx.sql`: the handles a handler reaches data through. */
const dataAccess = (node: AstNode): string | undefined => {
	if (node.type !== 'MemberExpression' || identifierName(child(node, 'object')) !== 'ctx') return undefined
	const property = staticKey(node, 'property')
	return property === 'db' || property === 'sql' ? property : undefined
}

/** The architecture's hints at one node: a handler outside `endpoints.ts`, data access outside `endpoints.ts`/`queries.ts`. */
export const checkStructureNode = (place: StructurePlace, node: AstNode, report: Report): void => {
	if (place.exempt || place.generated) return
	const handle = handledProcedure(node)?.handle
	if (handle !== undefined && place.part !== 'endpoints') {
		report(
			handle,
			'handler-location',
			"a handler outside a slice's endpoints.ts",
			'.handle(…) in src/<slice>/endpoints.ts, whose group fabrika.contract.ts composes',
		)
	}
	const handleName = dataAccess(node)
	if (handleName === undefined || place.part === 'endpoints' || place.part === 'queries') return
	if (place.part === 'logic') report(node, 'logic-data-access', `ctx.${handleName} in logic`, LOGIC_ALLOWED)
	else {
		report(
			node,
			'data-access-location',
			"data access outside a slice's endpoints.ts and queries.ts",
			'ctx.db and ctx.sql in a handler of src/<slice>/endpoints.ts; reusable data access in src/<slice>/queries.ts, over the handle the handler passes in',
		)
	}
}
