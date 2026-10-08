import { ContractError, describeContract } from '@fabrika/app/contract'
import { positionOf } from '../ast'
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
	try {
		describeContract(read.contract)
		return []
	} catch (error) {
		if (!(error instanceof ContractError)) {
			throw error
		}
		const module = graph.module(CONTRACT_FILE)
		const binding = module === undefined ? undefined : graph.binding(module, CONTRACT_EXPORT)
		const at = binding?.kind === 'const' && binding.init !== undefined ? positionOf(binding.init) : { line: 1, column: 1 }
		return error.problems.map((problem): Finding => {
			const parts = ALLOWED_SUFFIX.exec(problem)?.groups
			return {
				file: CONTRACT_FILE,
				...at,
				rule: 'contract',
				message: parts?.['message'] ?? problem,
				allowed: parts?.['allowed'] ?? SCHEMA_SUBSET,
			}
		})
	}
}
