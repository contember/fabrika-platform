import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ParsedModule, parseModule, walk } from './ast'
import { contractModules } from './contract'
import { compareFindings, type Finding, reporter } from './finding'
import { ModuleGraph } from './graph'
import {
	CONTRACT_FILE,
	GENERATED_ENTRY_FILE,
	isCheckedFile,
	isIgnoredSegment,
	isJsonFile,
	isSourceFile,
	isTestFile,
	TABLES_FILE,
	ZEROPS_FILES,
} from './layout'
import { type ModuleReference, moduleReferences } from './references'
import { type ImportMappings, readImportMappings } from './resolution'
import { checkContractRead } from './rules/contract'
import { checkCrontab, contractJobs } from './rules/crontab'
import { checkFrameworkWrite, trustedBindings } from './rules/framework'
import { checkClientIdentity } from './rules/identity'
import { checkGeneratedTests } from './rules/isolation'
import { checkJsonStrings } from './rules/json'
import { checkLiteralGraph } from './rules/literal'
import { checkMigrationNames } from './rules/migrations'
import { checkModuleReferences } from './rules/modules'
import { checkAmbientModule, checkPackageReplacement } from './rules/packages'
import { checkRuntimeNode } from './rules/runtime'
import { checkStructureNode, checkStructureReferences, structurePlace } from './rules/structure'
import { checkGeneratedTest, checkMockModule, checkTestNode, checkTestSuiteConfig } from './rules/tests'
import { checkComments, checkTypeNode } from './rules/types'
import { moduleSlice, sliceFinding } from './slice'
import { BUNFIG_FILE, checkTrustedResolution } from './trust'

export interface CheckInput {
	/** The application's root directory. */
	readonly root: string
	/** The application's files keyed by path relative to `root` with `/` separators; read from disk under `root` when omitted. */
	readonly files?: ReadonlyMap<string, string>
}

export interface ApplicationTree {
	readonly files: ReadonlyMap<string, string>
	/** Symbolic links outside the skipped directories; the checker does not follow them. */
	readonly links: readonly string[]
}

/** Every file the checker reads, by relative path, and the symbolic links it refuses to follow. */
export const readApplicationTree = async (root: string): Promise<ApplicationTree> => {
	const files = new Map<string, string>()
	const links: string[] = []
	const visit = async (relativeDirectory: string): Promise<void> => {
		const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true })
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const path = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
			if (isIgnoredSegment(entry.name) && !isCheckedFile(path)) continue
			if (entry.isSymbolicLink()) links.push(path)
			else if (entry.isDirectory()) await visit(path)
			else if (entry.isFile() && isCheckedFile(path)) files.set(path, await readFile(join(root, path), 'utf8'))
		}
	}
	await visit('')
	return { files, links }
}

const checkSourceModule = async (
	module: ParsedModule,
	references: readonly ModuleReference[],
	text: string,
	mappings: ImportMappings,
	files: ReadonlyMap<string, string>,
	findings: Finding[],
): Promise<void> => {
	const exists = (path: string): boolean => files.has(path)
	const report = reporter(module.file, findings)
	const isGeneratedEntry = module.file === GENERATED_ENTRY_FILE
	const isTest = isTestFile(module.file)
	const context = { report, isGeneratedEntry }
	const trusted = trustedBindings(module.file, module.program, mappings)
	const place = structurePlace(module.file, isGeneratedEntry)
	walk(module.program, (node, ancestors) => {
		checkRuntimeNode(node, ancestors, context)
		checkFrameworkWrite(node, ancestors, trusted, report)
		checkTypeNode(node, report)
		checkAmbientModule(node, report)
		if (isTest) checkTestNode(node, report)
		checkMockModule(node, module.file, files, report)
		checkStructureNode(place, node, report)
	})
	checkComments(module.comments, report)
	checkModuleReferences(module.file, references, mappings, exists, report, isGeneratedEntry, isTest)
	await checkGeneratedTest(text, module.comments, report)
}

/** `module` as its shell slice (itself when it holds no colocated handler), and the `.handle(…)` forms it refused. */
const shellModule = (module: ParsedModule, text: string): { readonly module: ParsedModule; readonly refusals: readonly Finding[] } => {
	const slice = moduleSlice(module, text)
	const refusals = slice.refusals.map((refusal) => sliceFinding(module, refusal))
	const parsed = slice.text === text ? undefined : parseModule(module.file, slice.text)
	return { module: parsed?.ok === true ? parsed.module : module, refusals }
}

/** Runs every rule over one application and returns the findings in file, line and column order. */
export const checkApplication = async (input: CheckInput): Promise<Finding[]> => {
	const tree: ApplicationTree = input.files === undefined ? await readApplicationTree(input.root) : { files: input.files, links: [] }
	const findings: Finding[] = []
	const modules = new Map<string, ParsedModule>()
	const references = new Map<string, readonly ModuleReference[]>()
	const checkedPaths = [...tree.files.keys()].filter(isCheckedFile).sort()
	const mappings = readImportMappings(tree.files)
	const trust = checkTrustedResolution(tree.files)
	findings.push(...trust)
	findings.push(...checkPackageReplacement(tree.files))

	for (const link of tree.links) {
		findings.push({
			file: link,
			line: 1,
			column: 1,
			severity: 'refusal',
			rule: 'unchecked-import',
			message: 'a symbolic link, which the checker does not follow',
			allowed: 'a regular file or directory inside the application',
		})
	}
	for (const path of checkedPaths) {
		const text = tree.files.get(path) ?? ''
		if (isJsonFile(path)) checkJsonStrings(text, reporter(path, findings))
		if (!isSourceFile(path)) continue
		const parsed = parseModule(path, text)
		if (!parsed.ok) {
			reporter(path, findings)(parsed.position, 'parse-error', parsed.message, 'source the TypeScript parser accepts')
			continue
		}
		modules.set(path, parsed.module)
		const referencesOfModule = moduleReferences(parsed.module.program)
		references.set(path, referencesOfModule)
		await checkSourceModule(parsed.module, referencesOfModule, text, mappings, tree.files, findings)
	}
	const structure = { files: tree.files, mappings, referencesOf: (path: string) => references.get(path) ?? [] }
	for (const path of modules.keys()) {
		checkStructureReferences(structure, structurePlace(path, path === GENERATED_ENTRY_FILE), reporter(path, findings))
	}

	// The contract rules read each module's shell slice: a colocated handler, and what only it uses, is application
	// code, which the rules above checked in full.
	const shell = new Map([...modules].map(([path, module]) => [path, shellModule(module, tree.files.get(path) ?? '')]))
	const graph = new ModuleGraph(new Map([...shell].map(([path, slice]) => [path, slice.module])))
	const contract = graph.module(CONTRACT_FILE)
	const tables = graph.module(TABLES_FILE)
	const shellGraph = new Set(
		[contract, tables].flatMap((entry) => (entry === undefined ? [] : contractModules(graph, entry))).map((module) => module.file),
	)
	const literal = [
		...[...shellGraph].flatMap((path) => shell.get(path)?.refusals ?? []),
		...checkLiteralGraph([CONTRACT_FILE, TABLES_FILE], graph),
	]
	findings.push(...literal)
	const contractRead = contract !== undefined && literal.length === 0 ? checkContractRead(graph) : []
	findings.push(...contractRead)
	for (const module of contract === undefined ? [] : contractModules(graph, contract)) findings.push(...checkClientIdentity(module, graph))
	findings.push(...(await checkGeneratedTests(tree.files, literal.length === 0 && trust.length === 0 && contractRead.length === 0)))
	findings.push(...checkMigrationNames(checkedPaths))
	const bunfig = tree.files.get(BUNFIG_FILE)
	if (bunfig !== undefined) findings.push(...checkTestSuiteConfig(bunfig))
	const jobs = contract === undefined ? [] : contractJobs(contract, graph)
	for (const name of ZEROPS_FILES) {
		const text = tree.files.get(name)
		if (text !== undefined) findings.push(...checkCrontab(name, text, jobs))
	}
	return findings.sort(compareFindings)
}
