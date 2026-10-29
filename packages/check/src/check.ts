import { type AnyContract, compileContract, ContractError } from '@fabrika/app/contract'
import type { ContractArtifact } from '@fabrika/auth-core'
import { type TablePolicies, tablePolicies, type Tables } from '@fabrika/db/tables'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type AstNode, type ParsedModule, parseModule, walk } from './ast'
import { contractModules, readContractModule } from './contract'
import { applicationDialect } from './dialect'
import { compareFindings, type Finding, reporter } from './finding'
import { ModuleGraph } from './graph'
import {
	CONTRACT_FILE,
	GENERATED_ENTRY_FILE,
	isCheckedFile,
	isIgnoredSegment,
	isJsonFile,
	isServerModule,
	isSourceFile,
	isTestFile,
	TABLES_FILE,
	ZEROPS_FILES,
} from './layout'
import type { PackedSet } from './packed'
import { ReaderProblems } from './reader/problems'
import { readTablesValue } from './reader/tables'
import { type ModuleReference, moduleReferences } from './references'
import { type ImportMappings, readImportMappings } from './resolution'
import { checkCloudflareContract } from './rules/cloudflare'
import { checkContractRead } from './rules/contract'
import { checkCrontab, contractJobs } from './rules/crontab'
import { checkFrameworkWrite, trustedBindings } from './rules/framework'
import { checkClientIdentity } from './rules/identity'
import { checkGeneratedTests } from './rules/isolation'
import { checkJsonStrings } from './rules/json'
import { checkLiteralGraph } from './rules/literal'
import {
	checkConflictIndexes,
	checkCurrentTimestampDefaults,
	checkFileColumnMigrations,
	checkMigrationNames,
	checkSqliteFrameworkNames,
	type ConflictInsert,
	type FileColumn,
} from './rules/migrations'
import { checkModuleReferences } from './rules/modules'
import { checkAmbientModule, checkPackageReplacement } from './rules/packages'
import { checkBackupPlan, checkMigrationClassification } from './rules/platform-migrations'
import { checkRuntimeNode, crossAppFetchMessage, rawSqlBindings } from './rules/runtime'
import { checkStructureNode, checkStructureReferences, structurePlace } from './rules/structure'
import { checkGeneratedTest, checkMockModule, checkTestNode, checkTestSuiteConfig } from './rules/tests'
import { checkComments, checkTypeNode } from './rules/types'
import { moduleSlice, sliceFinding } from './slice'
import { BUNFIG_FILE, checkTrustedResolution } from './trust'

/** Every file column the table policies declare, with its kind. */
const fileColumns = (policies: TablePolicies): FileColumn[] =>
	Object.entries(policies).flatMap(([table, policy]) => Object.entries(policy.files ?? {}).map(([column, kind]) => ({ table, column, kind })))

export interface CheckInput {
	/** The application's root directory. */
	readonly root: string
	/** The application's files keyed by path relative to `root` with `/` separators; read from disk under `root` when omitted. */
	readonly files?: ReadonlyMap<string, string>
	/** A local pack whose tarballs `package-replacement` accepts (`fabrika-check --packed`); a deploy build gives none. */
	readonly packed?: PackedSet
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

/** The findings a module rule leaves until the contract is read: they depend on what it declares. */
interface ContractDependent {
	/** Each `fetch` of an absolute URL, with its static prefix. */
	readonly fetches: { readonly target: string; readonly finding: Finding }[]
	/** Each `ctx.url` with a literal endpoint id. */
	readonly urls: { readonly endpoint: string; readonly finding: Finding }[]
	/** Each insert with literal `onConflict.columns`, checked against the migrations' unique indexes. */
	readonly inserts: ConflictInsert[]
}

const checkSourceModule = async (
	module: ParsedModule,
	references: readonly ModuleReference[],
	text: string,
	mappings: ImportMappings,
	files: ReadonlyMap<string, string>,
	findings: Finding[],
	dependent: ContractDependent,
): Promise<void> => {
	const exists = (path: string): boolean => files.has(path)
	const report = reporter(module.file, findings)
	const isGeneratedEntry = module.file === GENERATED_ENTRY_FILE
	const isTest = isTestFile(module.file)
	const deferred = (at: AstNode, rule: 'cross-app-fetch' | 'url-endpoint' | 'on-conflict-index', message: string, allowed: string): Finding[] => {
		const found: Finding[] = []
		reporter(module.file, found)(at, rule, message, allowed)
		return found
	}
	const context = {
		report,
		isGeneratedEntry,
		rawSql: rawSqlBindings(module.program),
		isServerModule: isServerModule(module.file),
		absoluteFetch: (node: AstNode, target: string) => {
			const { message, allowed } = crossAppFetchMessage(target)
			for (const finding of deferred(node, 'cross-app-fetch', message, allowed)) dependent.fetches.push({ target, finding })
		},
		appUrl: (node: AstNode, endpoint: string) => {
			const message = `ctx.url names '${endpoint}', which is no procedure of the contract`
			for (const finding of deferred(node, 'url-endpoint', message, URL_ENDPOINT_ALLOWED)) dependent.urls.push({ endpoint, finding })
		},
		conflictInsert: (node: AstNode, table: string, columns: readonly string[]) => {
			const message = `${table}.insert names onConflict columns (${columns.join(', ')}) that no unique index of a migration covers`
			const allowed = `a migration with create unique index ${table}_${columns.join('_')} on ${table} (${columns.join(', ')}), or the columns of one`
			for (const finding of deferred(node, 'on-conflict-index', message, allowed)) dependent.inserts.push({ table, columns, finding })
		},
	}
	const trusted = trustedBindings(module.file, module.program, mappings)
	const place = structurePlace(module.file, isGeneratedEntry)
	walk(module.program, (node, ancestors) => {
		checkRuntimeNode(node, ancestors, context)
		checkFrameworkWrite(node, ancestors, trusted, report)
		checkTypeNode(node, report)
		checkAmbientModule(node, report)
		if (isTest) checkTestNode(node, ancestors, report)
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

const URL_ENDPOINT_ALLOWED = "the id of a procedure of the contract: ctx.url('<mount>.<group>.<procedure>', { input?, query? })"

/** What the module rules that wait for the contract compare against: its procedure ids and every declared origin. */
interface CompiledReach {
	readonly procedures: ReadonlySet<string>
	readonly origins: readonly string[]
}

/** The contract's artifact, or `null` when it does not compile, which its own rule reports. */
const compiledArtifact = (contract: AnyContract, tables: Tables<unknown, unknown> | null): ContractArtifact | null => {
	try {
		return compileContract(contract, tables ?? {})
	} catch (error) {
		if (error instanceof ContractError) return null
		throw error
	}
}

/** The contract's procedures and origins. */
const compiledReach = (artifact: ContractArtifact): CompiledReach => {
	const procedures = artifact.endpoints.filter((row) =>
		(row.kind === 'query' || row.kind === 'mutation' || row.kind === 'public') && row.source.kind === 'mount'
	)
	return {
		procedures: new Set(procedures.map((row) => row.id)),
		origins: Object.values(artifact.declared ?? {}).flatMap((reach) => reach.egress ?? []),
	}
}

/**
 * A `fetch` of an absolute URL stands when no site declares its origin (a static prefix that ends inside the host is
 * not accepted), and every one stands when the contract does not compile. A `ctx.url` stands when the contract
 * compiles and names no such procedure. The runtime guard on `fetch` still checks the site that runs.
 */
const contractDependentFindings = (dependent: ContractDependent, reach: CompiledReach | null): Finding[] => [
	...dependent.fetches.filter(({ target }) => reach === null || !reach.origins.some((origin) => isWithinOrigin(target, origin))).map(({ finding }) =>
		finding
	),
	...(reach === null ? [] : dependent.urls.filter(({ endpoint }) => !reach.procedures.has(endpoint)).map(({ finding }) => finding)),
]

const isWithinOrigin = (target: string, origin: string): boolean =>
	target.startsWith(`${origin}/`) || target.startsWith(`${origin}?`) || target.startsWith(`${origin}#`)

/** Runs every rule over one application and returns the findings in file, line and column order. */
export const checkApplication = async (input: CheckInput): Promise<Finding[]> => {
	const tree: ApplicationTree = input.files === undefined ? await readApplicationTree(input.root) : { files: input.files, links: [] }
	const findings: Finding[] = []
	const modules = new Map<string, ParsedModule>()
	const references = new Map<string, readonly ModuleReference[]>()
	const dependent: ContractDependent = { fetches: [], urls: [], inserts: [] }
	const checkedPaths = [...tree.files.keys()].filter(isCheckedFile).sort()
	const mappings = readImportMappings(tree.files)
	const trust = checkTrustedResolution(tree.files)
	findings.push(...trust)
	findings.push(...checkPackageReplacement(tree.files, input.packed))

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
		await checkSourceModule(parsed.module, referencesOfModule, text, mappings, tree.files, findings, dependent)
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
	const read = contract !== undefined && literal.length === 0 && contractRead.length === 0 ? readContractModule(graph) : undefined
	const declaredTables = tables !== undefined && literal.length === 0 ? readTablesValue(graph, tables, new ReaderProblems()) : null
	const artifact = read?.ok === true ? compiledArtifact(read.contract, declaredTables) : null
	findings.push(...contractDependentFindings(dependent, artifact === null ? null : compiledReach(artifact)))
	if (artifact !== null) findings.push(...checkMigrationClassification(tree.files, artifact.app))
	if (applicationDialect(tree.files) === 'sqlite') {
		if (artifact !== null) findings.push(...checkCloudflareContract(artifact))
		findings.push(...checkCurrentTimestampDefaults(tree.files))
		findings.push(...checkSqliteFrameworkNames(tree.files))
		findings.push(...(await checkBackupPlan(tree.files)))
	}
	if (declaredTables !== null) {
		const policies = tablePolicies(declaredTables)
		findings.push(...checkFileColumnMigrations(tree.files, fileColumns(policies)))
		findings.push(...checkConflictIndexes(tree.files, new Set(Object.keys(policies)), dependent.inserts))
	}
	const bunfig = tree.files.get(BUNFIG_FILE)
	if (bunfig !== undefined) findings.push(...checkTestSuiteConfig(bunfig))
	const jobs = contract === undefined ? [] : contractJobs(contract, graph)
	for (const name of ZEROPS_FILES) {
		const text = tree.files.get(name)
		if (text !== undefined) findings.push(...checkCrontab(name, text, jobs))
	}
	return findings.sort(compareFindings)
}
