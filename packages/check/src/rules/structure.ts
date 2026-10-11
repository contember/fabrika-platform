import { type AstNode, child, identifierName, staticKey } from '../ast'
import { HINT_RULE_IDS, type Report } from '../finding'
import {
	CONTRACT_FILE,
	DATABASE_DIR,
	isRelativeSpecifier,
	isSourceFile,
	isTestFile,
	resolveRelative,
	SCHEMAS_DIR,
	SCHEMAS_FILE,
	SLICE_ENDPOINTS_FILE,
	SLICE_LOGIC_FILE,
	SLICE_QUERIES_FILE,
	SPA_DIR,
} from '../layout'
import type { ModuleReference } from '../references'
import { type ImportMappings, mappedTargets } from '../resolution'
import { isTestKit } from './modules'
import { isGeneratedTestPath } from './tests'

/** The rules of the application architecture (docs/reference/application-architecture.md): three refusals and the hints. */
export const STRUCTURE_RULE_IDS = ['spa-server-import', 'layer-import', 'generated-test-import', ...HINT_RULE_IDS] as const

type SlicePart = 'endpoints' | 'logic' | 'queries'

const SLICE_PARTS: ReadonlyMap<string, SlicePart> = new Map([
	[SLICE_ENDPOINTS_FILE, 'endpoints'],
	[SLICE_LOGIC_FILE, 'logic'],
	[SLICE_QUERIES_FILE, 'queries'],
])

/** Directories under `src/` the layout gives another role; every other `src/<name>/` is the slice `<name>`. */
const NOT_SLICES: ReadonlySet<string> = new Set([DATABASE_DIR, SCHEMAS_DIR, 'src/__tests__/'])

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
}

export const structurePlace = (file: string, isGeneratedEntry: boolean): StructurePlace => ({
	file,
	slice: sliceOf(file),
	part: slicePart(file),
	exempt: isGeneratedEntry || isTestFile(file),
})

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
const referenceTargets = (file: string, specifier: string, mappings: ImportMappings, exists: (path: string) => boolean): Targets => {
	if (isRelativeSpecifier(specifier)) return { files: resolvedFiles(exists, file, specifier), packages: [] }
	if (specifier.startsWith('/') || /^file:/i.test(specifier)) return { files: [], packages: [] }
	const mapped = mappedTargets(mappings, specifier)
	if (mapped === undefined) return { files: [], packages: [specifier] }
	// Mapping targets are relative to the root, where both package.json and tsconfig.json live.
	const files = mapped.filter(isRelativeSpecifier).flatMap((target) => resolvedFiles(exists, 'package.json', target))
	const packages = mapped.filter((target) => !isRelativeSpecifier(target) && !target.startsWith('/'))
	return { files, packages }
}

const isDataPackage = (specifier: string): boolean => specifier === '@fabrika/db' || specifier.startsWith('@fabrika/db/')

/** The framework modules logic and queries may import; the rest of `@fabrika/*` is the framework's own composition. */
const LAYER_PACKAGES: ReadonlySet<string> = new Set(['@fabrika/app', '@fabrika/db'])

const SPA_ALLOWED = '@fabrika/app/client, fabrika.contract.ts, src/schemas.ts and modules under web/; a type-only import of anything else'

/** The application modules a bundle of the SPA may load; `fabrika.contract.ts` is loaded without its handlers. */
const isSpaModule = (path: string): boolean =>
	path.startsWith(SPA_DIR) || path === CONTRACT_FILE || path === SCHEMAS_FILE || path.startsWith(SCHEMAS_DIR) || !isSourceFile(path)

const isServerPackage = (specifier: string): boolean =>
	specifier.startsWith('@fabrika/')
		? specifier !== '@fabrika/app/client'
		: specifier === 'bun' || specifier.startsWith('bun:') || specifier.startsWith('node:')

const checkSpaReference = (reference: ModuleReference, targets: Targets, report: Report): void => {
	const server = targets.packages.some(isServerPackage) || targets.files.some((path) => !isSpaModule(path))
	if (server) report(reference.node, 'spa-server-import', `'${reference.specifier}' is server code, imported by the SPA`, SPA_ALLOWED)
}

const checkLayerReference = (place: StructurePlace, reference: ModuleReference, targets: Targets, report: Report): void => {
	// The test kits are `test-only-import`'s finding everywhere outside a test file.
	const internal = targets.packages.find((specifier) => specifier.startsWith('@fabrika/') && !LAYER_PACKAGES.has(specifier) && !isTestKit(specifier))
	if (internal === undefined) return
	report(
		reference.node,
		'layer-import',
		`'${internal}' is a framework module, imported by ${place.part === 'logic' ? 'logic' : 'queries'}`,
		'@fabrika/app (its errors) and @fabrika/db (fromRow and handle types) only; the handler in endpoints.ts uses the rest',
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

/** The architecture's rules over one module's imports, re-exports and loads. */
export const checkStructureReferences = (
	place: StructurePlace,
	references: readonly ModuleReference[],
	mappings: ImportMappings,
	files: ReadonlyMap<string, string>,
	report: Report,
): void => {
	const exists = (path: string): boolean => files.has(path)
	for (const reference of references) {
		const targets = referenceTargets(place.file, reference.specifier, mappings, exists)
		if (targets.files.some((path) => isGeneratedTestPath(path, files))) {
			report(
				reference.node,
				'generated-test-import',
				`'${reference.specifier}' is a generated test, which no module imports`,
				'a helper module of your own; fabrika db test-scaffold rewrites the generated tests',
			)
		}
		if (reference.typeOnly) continue
		if (place.file.startsWith(SPA_DIR) && !place.exempt) checkSpaReference(reference, targets, report)
		if (place.part === 'logic' || place.part === 'queries') checkLayerReference(place, reference, targets, report)
		if (place.exempt) continue
		if (place.part === 'logic') checkLogicReference(reference, targets, report)
		else if (place.slice !== undefined) checkSliceReference(place, reference, targets, report)
	}
}

/** The builders whose procedure takes a handler: `r.query(…).handle(…)`. */
const PROCEDURE_BUILDERS: ReadonlySet<string> = new Set(['query', 'mutation', 'cron', 'webhook', 'export'])

/** `.handle` of `<x>.<builder>(…).handle(…)`: the property node, where a finding points. */
const handlerProperty = (node: AstNode): AstNode | undefined => {
	if (node.type !== 'CallExpression') return undefined
	const callee = child(node, 'callee')
	if (callee?.type !== 'MemberExpression' || staticKey(callee, 'property') !== 'handle') return undefined
	const procedure = child(callee, 'object')
	const builder = procedure?.type === 'CallExpression' ? child(procedure, 'callee') : undefined
	if (builder?.type !== 'MemberExpression') return undefined
	const name = staticKey(builder, 'property')
	return name !== undefined && PROCEDURE_BUILDERS.has(name) ? child(callee, 'property') : undefined
}

/** `ctx.db` or `ctx.sql`: the handles a handler reaches data through. */
const dataAccess = (node: AstNode): string | undefined => {
	if (node.type !== 'MemberExpression' || identifierName(child(node, 'object')) !== 'ctx') return undefined
	const property = staticKey(node, 'property')
	return property === 'db' || property === 'sql' ? property : undefined
}

/** The architecture's hints at one node: a handler outside `endpoints.ts`, data access outside `endpoints.ts`/`queries.ts`. */
export const checkStructureNode = (place: StructurePlace, node: AstNode, report: Report): void => {
	if (place.exempt) return
	const handle = handlerProperty(node)
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
