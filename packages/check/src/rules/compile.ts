import { ContractError } from '@fabrika/app/contract'
import { ContractSourceError, readContractSource, readTablesDefinition } from '../contract'
import type { Finding } from '../finding'
import { CONTRACT_FILE } from '../layout'

/**
 * What the reader refuses of `src/db/tables.ts`, and a contract that does not compile against its policies: Control
 * reads the commit with the same calls and refuses the deploy. `readable` is false while the literal, trust or
 * contract rules report the sources, so a refusal is not reported twice.
 */
export const checkContractCompiles = (files: ReadonlyMap<string, string>, readable: boolean): Finding[] => {
	if (!readable) return []
	try {
		const tables = readTablesDefinition(files)
		if (files.has(CONTRACT_FILE) && tables !== null) readContractSource(files, tables)
		return []
	} catch (error) {
		if (error instanceof ContractSourceError) return [...error.findings]
		if (error instanceof ContractError) {
			return error.problems.map((problem): Finding => ({
				file: CONTRACT_FILE,
				line: 1,
				column: 1,
				severity: 'refusal',
				rule: 'contract',
				message: problem,
				allowed: 'a contract that compiles against src/db/tables.ts',
			}))
		}
		throw error
	}
}
