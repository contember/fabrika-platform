import { type ContractDeclaration, ContractError, describeContract, isProcedure, type ProcedureTreeDeclaration } from '@fabrika/app/contract'
import type { SchemaShape } from '@fabrika/auth-core'
import { type Position, positionOf } from '../ast'
import { readContractModule } from '../contract'
import type { Finding } from '../finding'
import type { ModuleGraph } from '../graph'
import { CONTRACT_EXPORT, CONTRACT_FILE } from '../layout'

const SCHEMA_SUBSET = 'a schema of the supported z subset (packages/check/CLAUDE.md)'
const ALLOWED_SUFFIX = /^(?<message>.*) \(allowed: (?<allowed>.*)\)$/s

/**
 * What Control's static reader refuses, reported in the build: a form the reader cannot read into the contract, and a
 * schema `describeContract` refuses. Runs only once the literal rule passes. Table policies are not read yet (A8b), so
 * the checks `buildArtifact` makes against them run only where the tables are known.
 */
export const checkContractRead = (graph: ModuleGraph): Finding[] => {
	const read = readContractModule(graph)
	if (!read.ok) {
		return [...read.findings]
	}
	const module = graph.module(CONTRACT_FILE)
	const binding = module === undefined ? undefined : graph.binding(module, CONTRACT_EXPORT)
	const at = binding?.kind === 'const' && binding.init !== undefined ? positionOf(binding.init) : { line: 1, column: 1 }
	try {
		return memberAdmitsExternal(describeContract(read.contract), at)
	} catch (error) {
		if (!(error instanceof ContractError)) {
			throw error
		}
		return error.problems.map((problem): Finding => {
			const parts = ALLOWED_SUFFIX.exec(problem)?.groups
			return {
				file: CONTRACT_FILE,
				...at,
				severity: 'refusal',
				rule: 'contract',
				message: parts?.['message'] ?? problem,
				allowed: parts?.['allowed'] ?? SCHEMA_SUBSET,
			}
		})
	}
}

/**
 * `{ member: true }` admits a caller holding any permission of the application, so in a contract that declares an
 * external role it admits the people from outside the organization who hold it (ADR-0051). A staff-only surface names
 * an action that only internal roles grant. A hint: an endpoint for every member, externals included, is legitimate.
 */
function memberAdmitsExternal(contract: ContractDeclaration<SchemaShape>, at: Position): Finding[] {
	const external = Object.entries(contract.roles).filter(([, role]) => role.external === true).map(([name]) => name)
	if (external.length === 0) {
		return []
	}
	const roles = external.map((name) => `'${name}'`).join(', ')
	const sites: string[] = []
	for (const [name, mount] of Object.entries(contract.mounts)) {
		// A machine-only mount admits services, and an external principal is always a user.
		if (mount.kind === 'rpc' && mount.callers.includes('human')) sites.push(...memberProcedures(mount.procedures, name))
		if (mount.kind === 'spa' && 'member' in mount.access) sites.push(name)
	}
	return sites.map((site): Finding => ({
		file: CONTRACT_FILE,
		...at,
		severity: 'hint',
		rule: 'member-admits-external',
		message: `'${site}' admits every member, and external role ${roles} makes a person from outside the organization one`,
		allowed: 'a staff-only endpoint requires an action only internal roles grant: { action, over } or { action, app: true }',
	}))
}

function memberProcedures(tree: ProcedureTreeDeclaration<SchemaShape>, path: string): string[] {
	return Object.entries(tree).flatMap(([name, entry]) => {
		const at = `${path}.${name}`
		if (isProcedure(entry)) return 'member' in entry.access ? [at] : []
		return memberProcedures(entry, at)
	})
}
