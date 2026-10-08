import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ParsedModule, parseModule, walk } from './ast'
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
import { moduleReferences } from './references'
import { type ImportMappings, readImportMappings } from './resolution'
import { checkContractRead } from './rules/contract'
import { checkCrontab, contractJobs } from './rules/crontab'
import { checkClientIdentity } from './rules/identity'
import { checkIsolationTests } from './rules/isolation'
import { checkJsonStrings } from './rules/json'
import { checkLiteralGraph } from './rules/literal'
import { checkMigrationNames } from './rules/migrations'
import { checkModuleReferences } from './rules/modules'
import { checkAmbientModule, checkPackageReplacement } from './rules/packages'
import { checkRuntimeNode } from './rules/runtime'
import { checkGeneratedTest, checkTestNode } from './rules/tests'
import { checkComments, checkTypeNode } from './rules/types'
import { checkTrustedResolution } from './trust'

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
	text: string,
	mappings: ImportMappings,
	exists: (path: string) => boolean,
	findings: Finding[],
): Promise<void> => {
	const report = reporter(module.file, findings)
	const isGeneratedEntry = module.file === GENERATED_ENTRY_FILE
	const isTest = isTestFile(module.file)
	const context = { report, isGeneratedEntry }
	walk(module.program, (node, ancestors) => {
		checkRuntimeNode(node, ancestors, context)
		checkTypeNode(node, report)
		checkAmbientModule(node, report)
		if (isTest) checkTestNode(node, report)
	})
	checkComments(module.comments, report)
	checkModuleReferences(module.file, moduleReferences(module.program), mappings, exists, report, isGeneratedEntry, isTest)
	await checkGeneratedTest(text, module.comments, report)
}

/** Runs every rule over one application and returns the findings in file, line and column order. */
export const checkApplication = async (input: CheckInput): Promise<Finding[]> => {
	const tree: ApplicationTree = input.files === undefined ? await readApplicationTree(input.root) : { files: input.files, links: [] }
	const findings: Finding[] = []
	const modules = new Map<string, ParsedModule>()
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
		await checkSourceModule(parsed.module, text, mappings, (candidate) => tree.files.has(candidate), findings)
	}

	const graph = new ModuleGraph(modules)
	const literal = checkLiteralGraph([CONTRACT_FILE, TABLES_FILE], graph)
	findings.push(...literal)
	const contract = modules.get(CONTRACT_FILE)
	if (contract !== undefined && literal.length === 0) findings.push(...checkContractRead(graph))
	if (contract !== undefined) findings.push(...checkClientIdentity(contract, graph))
	findings.push(...(await checkIsolationTests(tree.files, literal.length === 0 && trust.length === 0)))
	findings.push(...checkMigrationNames(checkedPaths))
	const jobs = contract === undefined ? [] : contractJobs(contract, graph)
	for (const name of ZEROPS_FILES) {
		const text = tree.files.get(name)
		if (text !== undefined) findings.push(...checkCrontab(name, text, jobs))
	}
	return findings.sort(compareFindings)
}
