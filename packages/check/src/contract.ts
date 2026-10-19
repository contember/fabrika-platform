// @fabrika/check/contract — the static contract reader. It reads `fabrika.contract.ts` and the schema modules it imports
// from their text, as Control has them at a commit, and executes no application code. Browser- and Worker-safe: no
// Node or Bun API, so a Worker can bundle it.

import { type AnyContract, compileContract } from '@fabrika/app/contract'
import type { ContractArtifact, TablePolicyArtifact } from '@fabrika/auth-core'
import { type TablePolicies, tablePolicies, type Tables } from '@fabrika/db/tables'
import { importedSpecifiers, nodeDepth, type ParsedModule, utf8Bytes } from './ast'
import { type Finding, formatFinding } from './finding'
import { ModuleGraph } from './graph'
import { CONTRACT_EXPORT, CONTRACT_FILE, isRelativeSpecifier, isSourceFile, resolveRelative, TABLES_FILE } from './layout'
import { CONTRACT_LIMITS } from './limits'
import { ReaderProblems } from './reader/problems'
import { readContractValue } from './reader/surface'
import { readTablesValue } from './reader/tables'
import { ValueReader } from './reader/value'
import { checkLiteralGraph } from './rules/literal'
import { parseShellModule } from './slice'
import { checkTrustedResolution } from './trust'

export { ContractError } from '@fabrika/app/contract'
export { type Finding, formatFinding } from './finding'
export { contractReaderInputs } from './inputs'
export { CONTRACT_FILE, MIGRATIONS_DIR, TABLES_FILE } from './layout'
export { CONTRACT_LIMITS } from './limits'
export { lockedRegistryVersion, LOCKFILE } from './lockfile'
export { CHECKER_VERSION } from './version'

/** Every form the reader refuses, each with its file, line, column and the allowed form. */
export class ContractSourceError extends Error {
	override readonly name = 'ContractSourceError'
	readonly findings: readonly Finding[]

	constructor(findings: readonly Finding[]) {
		super(`the contract cannot be read from source:\n${findings.map(formatFinding).join('\n')}`)
		this.findings = findings
	}
}

/**
 * The contract artifact of an application, read from the text of its files (path relative to the application root →
 * text): `fabrika.contract.ts`, every module it imports and the configuration that applies to them (`readContract`),
 * and `src/db/tables.ts` with the modules it imports (`readTablesDefinition`). `tables`, when given, replaces what
 * `src/db/tables.ts` declares: its parsed policies, or the artifact form of each policy, which names no inbox's
 * columns, so a form's fields are not checked against them.
 *
 * Throws `ContractSourceError` for a form the reader refuses, and `ContractError` with the same problems
 * `compileContract` reports for a contract that does not compile.
 */
export function readContractSource(
	files: ReadonlyMap<string, string>,
	tables?: Tables<unknown, unknown> | Readonly<Record<string, TablePolicyArtifact>>,
): ContractArtifact {
	const contract = readContract(files)
	return compileContract(contract, tables ?? readTablesDefinition(files) ?? {})
}

/**
 * The table policies of `src/db/tables.ts` in their artifact form (`readTablesDefinition`); none when `files` has no
 * such file. Throws `ContractSourceError`.
 */
export function readTablesSource(files: ReadonlyMap<string, string>): TablePolicies {
	const tables = readTablesDefinition(files)
	return tables === null ? {} : tablePolicies(tables)
}

/**
 * The table policies of `src/db/tables.ts`, read from source and parsed by `@fabrika/db`'s own policy parse, as
 * `defineTables` returns them; `null` when `files` has no such file. `files` carries its imports (the generated
 * `src/db/schema.generated.ts`) and the configuration `readContract` names. Throws `ContractSourceError`.
 */
export function readTablesDefinition(files: ReadonlyMap<string, string>): Tables<unknown, unknown> | null {
	if (!files.has(TABLES_FILE)) {
		return null
	}
	const trust = checkTrustedResolution(files)
	if (trust.length > 0) {
		throw new ContractSourceError(trust)
	}
	const parsed = parseSourceGraph(files, TABLES_FILE)
	if (!parsed.ok) {
		throw new ContractSourceError(parsed.findings)
	}
	const literal = checkLiteralGraph([TABLES_FILE], parsed.graph)
	const module = parsed.graph.module(TABLES_FILE)
	const budget = module === undefined ? [] : sourceBudget(contractModules(parsed.graph, module), TABLES_FILE)
	if (literal.length > 0 || budget.length > 0) {
		throw new ContractSourceError([...literal, ...budget])
	}
	if (module === undefined) {
		return null
	}
	const problems = new ReaderProblems()
	const tables = readTablesValue(parsed.graph, module, problems)
	if (tables === null || problems.findings.length > 0) {
		throw new ContractSourceError(problems.findings)
	}
	return tables
}

/**
 * The contract `defineContract` returns in the evaluated module, read from source; throws `ContractSourceError`.
 * Besides the contract's modules, `files` carries every `package.json`, `tsconfig.json`, `jsconfig.json` and
 * `bunfig.toml` that applies to them (the root and each directory of a contract module): one of them can redirect the
 * packages the reader trusts by name, and the reader cannot tell a missing file from an absent one.
 */
export function readContract(files: ReadonlyMap<string, string>): AnyContract {
	const trust = checkTrustedResolution(files)
	if (trust.length > 0) {
		throw new ContractSourceError(trust)
	}
	const parsed = parseSourceGraph(files, CONTRACT_FILE)
	if (!parsed.ok) {
		throw new ContractSourceError(parsed.findings)
	}
	const literal = checkLiteralGraph([CONTRACT_FILE], parsed.graph)
	if (literal.length > 0) {
		throw new ContractSourceError(literal)
	}
	const read = readContractModule(parsed.graph)
	if (!read.ok) {
		throw new ContractSourceError(read.findings)
	}
	return read.contract
}

export type ContractRead = { readonly ok: true; readonly contract: AnyContract } | { readonly ok: false; readonly findings: readonly Finding[] }

/** Reads the `contract` export of a graph whose contract modules already pass the literal rule. */
export function readContractModule(graph: ModuleGraph): ContractRead {
	const problems = new ReaderProblems()
	const module = graph.module(CONTRACT_FILE)
	if (module === undefined) {
		return { ok: false, findings: [missingFile(CONTRACT_FILE)] }
	}
	const budget = sourceBudget(contractModules(graph, module))
	if (budget.length > 0) {
		return { ok: false, findings: budget }
	}
	const value = new ValueReader(graph, problems).exported(module, CONTRACT_EXPORT, module.program)
	const contract = value === null ? null : readContractValue(value, problems)
	return contract === null || problems.findings.length > 0 ? { ok: false, findings: problems.findings } : { ok: true, contract }
}

/** The contract module and every module its value imports reach. */
export function contractModules(graph: ModuleGraph, entry: ParsedModule): ParsedModule[] {
	const reached = new Map<string, ParsedModule>()
	const queue = [entry]
	for (let module = queue.shift(); module !== undefined; module = queue.shift()) {
		if (reached.has(module.file)) {
			continue
		}
		reached.set(module.file, module)
		for (const imported of graph.index(module).imports.values()) {
			const target = graph.resolve(module.file, imported.specifier)
			if (target !== undefined) {
				queue.push(target)
			}
		}
	}
	return [...reached.values()]
}

/** The source and syntax-depth limits of `CONTRACT_LIMITS` over the modules of one entry (the contract or the tables). */
function sourceBudget(modules: readonly ParsedModule[], entry = CONTRACT_FILE): Finding[] {
	const findings: Finding[] = []
	const bytes = modules.reduce((total, module) => total + module.bytes, 0)
	if (bytes > CONTRACT_LIMITS.sourceBytes) {
		findings.push(overBudget(entry, `${entry} and its modules are ${bytes} bytes, over ${CONTRACT_LIMITS.sourceBytes}`))
	}
	for (const module of modules) {
		if (nodeDepth(module.program) > CONTRACT_LIMITS.astDepth) {
			findings.push(overBudget(module.file, `the syntax nests deeper than ${CONTRACT_LIMITS.astDepth} levels`))
		}
	}
	return findings
}

function overBudget(file: string, message: string): Finding {
	return {
		file,
		line: 1,
		column: 1,
		severity: 'refusal',
		rule: 'contract',
		message,
		allowed: 'a contract within CONTRACT_LIMITS (packages/check/CLAUDE.md)',
	}
}

type ParsedGraph = { readonly ok: true; readonly graph: ModuleGraph } | { readonly ok: false; readonly findings: readonly Finding[] }

/**
 * Parses `entry` (`fabrika.contract.ts` or `src/db/tables.ts`) and the modules its imports reach among `files`, and
 * nothing else; each module as its shell slice, so an import only a handler uses is never followed. Every candidate of an import is parsed, so that `rules/literal.ts` sees an ambiguous or directory
 * import; the size limit holds before a module is parsed and the depth limit right after, before any recursive rule
 * walks it.
 */
function parseSourceGraph(files: ReadonlyMap<string, string>, entry: string): ParsedGraph {
	const modules = new Map<string, ParsedModule>()
	const findings: Finding[] = []
	if (!files.has(entry)) {
		return { ok: false, findings: [missingFile(entry)] }
	}
	let bytes = 0
	const queue = [entry]
	for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
		const text = files.get(path)
		if (modules.has(path) || text === undefined || !isSourceFile(path)) {
			continue
		}
		bytes += utf8Bytes(text)
		if (bytes > CONTRACT_LIMITS.sourceBytes) {
			return { ok: false, findings: [overBudget(path, `${entry} and its modules are over ${CONTRACT_LIMITS.sourceBytes} bytes`)] }
		}
		const { parsed, refusals } = parseShellModule(path, text)
		findings.push(...refusals)
		if (!parsed.ok) {
			findings.push({
				file: path,
				...parsed.position,
				severity: 'refusal',
				rule: 'parse-error',
				message: parsed.message,
				allowed: 'source the TypeScript parser accepts',
			})
			continue
		}
		if (nodeDepth(parsed.module.program) > CONTRACT_LIMITS.astDepth) {
			return { ok: false, findings: [overBudget(path, `the syntax nests deeper than ${CONTRACT_LIMITS.astDepth} levels`)] }
		}
		modules.set(path, parsed.module)
		for (const specifier of importedSpecifiers(parsed.module)) {
			const resolution = isRelativeSpecifier(specifier) ? resolveRelative((candidate) => files.has(candidate), path, specifier) : undefined
			if (resolution?.kind === 'file') {
				queue.push(resolution.path)
			} else if (resolution?.kind === 'ambiguous' || resolution?.kind === 'directory') {
				queue.push(...resolution.paths)
			}
		}
	}
	return findings.length > 0 ? { ok: false, findings } : { ok: true, graph: new ModuleGraph(modules) }
}

function missingFile(file: string): Finding {
	return {
		file,
		line: 1,
		column: 1,
		severity: 'refusal',
		rule: 'contract',
		message: `the application has no ${file}`,
		allowed: `${file} with export const ${CONTRACT_EXPORT} = defineContract(…)`,
	}
}
