import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ParsedModule, parseModule, walk } from './ast'
import { compareFindings, type Finding, reporter } from './finding'
import { CONTRACT_FILE, GENERATED_ENTRY_FILE, isCheckedFile, isIgnoredSegment, isSourceFile, isTestFile, TABLES_FILE, ZEROPS_FILES } from './layout'
import { moduleReferences } from './references'
import { checkCrontab, contractJobs } from './rules/crontab'
import { checkClientIdentity } from './rules/identity'
import { checkLiteralGraph } from './rules/literal'
import { checkMigrationNames } from './rules/migrations'
import { checkModuleReferences } from './rules/modules'
import { checkRuntimeNode } from './rules/runtime'
import { checkGeneratedTest, checkTestNode } from './rules/tests'
import { checkComments, checkTypeNode } from './rules/types'

export interface CheckInput {
	/** The application's root directory. */
	readonly root: string
	/** The application's files keyed by path relative to `root` with `/` separators; read from disk under `root` when omitted. */
	readonly files?: ReadonlyMap<string, string>
}

/** Every file the checker reads, by relative path. Symbolic links are not followed. */
export const readApplicationFiles = async (root: string): Promise<ReadonlyMap<string, string>> => {
	const files = new Map<string, string>()
	const visit = async (relativeDirectory: string): Promise<void> => {
		const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true })
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const path = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
			if (entry.isDirectory()) {
				if (!isIgnoredSegment(entry.name)) await visit(path)
			} else if (entry.isFile() && isCheckedFile(path)) {
				files.set(path, await readFile(join(root, path), 'utf8'))
			}
		}
	}
	await visit('')
	return files
}

const checkSourceModule = async (module: ParsedModule, text: string, findings: Finding[]): Promise<void> => {
	const report = reporter(module.file, findings)
	const isGeneratedEntry = module.file === GENERATED_ENTRY_FILE
	const isTest = isTestFile(module.file)
	const context = { report, isGeneratedEntry }
	walk(module.program, (node, ancestors) => {
		checkRuntimeNode(node, ancestors, context)
		checkTypeNode(node, report)
		if (isTest) checkTestNode(node, report)
	})
	checkComments(module.comments, report)
	checkModuleReferences(module.file, moduleReferences(module.program), report, isGeneratedEntry)
	await checkGeneratedTest(text, report)
}

/** Runs every rule over one application and returns the findings in file, line and column order. */
export const checkApplication = async (input: CheckInput): Promise<Finding[]> => {
	const files = input.files ?? (await readApplicationFiles(input.root))
	const findings: Finding[] = []
	const modules = new Map<string, ParsedModule>()
	const checkedPaths = [...files.keys()].filter(isCheckedFile).sort()

	for (const path of checkedPaths) {
		const text = files.get(path) ?? ''
		if (!isSourceFile(path)) continue
		const parsed = parseModule(path, text)
		if (!parsed.ok) {
			reporter(path, findings)(parsed.position, 'parse-error', parsed.message, 'source the TypeScript parser accepts')
			continue
		}
		modules.set(path, parsed.module)
		await checkSourceModule(parsed.module, text, findings)
	}

	findings.push(...checkLiteralGraph([CONTRACT_FILE, TABLES_FILE], modules))
	const contract = modules.get(CONTRACT_FILE)
	if (contract !== undefined) findings.push(...checkClientIdentity(contract, modules))
	findings.push(...checkMigrationNames(checkedPaths))
	const jobs = contract === undefined ? [] : contractJobs(contract)
	for (const name of ZEROPS_FILES) {
		const text = files.get(name)
		if (text !== undefined) findings.push(...checkCrontab(name, text, jobs))
	}
	return findings.sort(compareFindings)
}
