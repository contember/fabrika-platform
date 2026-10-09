import { ContractError } from '@fabrika/app/contract'
import { ContractSourceError } from '../contract'
import type { Finding } from '../finding'
import { CONTRACT_FILE } from '../layout'
import { type GeneratedTest, generatedTests, scaffoldInputs } from '../scaffold'
import { GENERATED_TEST_HEADER, generatedTestHeader } from './tests'

const RESCAFFOLD = 'the files fabrika db test-scaffold writes for the current contract and src/db/tables.ts; run it and commit the result'

const at = (file: string, message: string): Finding => ({ file, line: 1, column: 1, rule: 'generated-test-hash', message, allowed: RESCAFFOLD })

/** Whether the first line is a generated-test header whose hash fails: `checkGeneratedTest` reports that file already. */
const failsItsHash = async (text: string): Promise<boolean> => {
	if (!text.startsWith(GENERATED_TEST_HEADER)) return false
	const newline = text.indexOf('\n')
	return newline === -1 || text.slice(0, newline) !== (await generatedTestHeader(text.slice(newline + 1)))
}

/** The tests the scaffold writes for these files, or the findings that stop it from reading them. */
export const expectedGeneratedTests = async (
	files: ReadonlyMap<string, string>,
): Promise<
	{ readonly ok: true; readonly tests: ReadonlyMap<string, GeneratedTest> } | { readonly ok: false; readonly findings: readonly Finding[] }
> => {
	try {
		const { policies, artifact } = scaffoldInputs(files)
		return { ok: true, tests: await generatedTests(policies, artifact) }
	} catch (error) {
		if (error instanceof ContractSourceError) return { ok: false, findings: error.findings }
		if (error instanceof ContractError) {
			return {
				ok: false,
				findings: error.problems.map((problem) => ({
					file: CONTRACT_FILE,
					line: 1,
					column: 1,
					rule: 'contract' as const,
					message: problem,
					allowed: 'a contract that compiles against src/db/tables.ts',
				})),
			}
		}
		throw error
	}
}

/**
 * Every generated test is byte for byte what the scaffold writes from the current contract and policies: a missing,
 * edited or replaced one is a finding, header or not, and so is a generated test the scaffold no longer writes.
 * `readable` is false while the literal or trust rules report the sources; otherwise what the reader refuses is
 * reported here, so a source it cannot read does not silence the check.
 */
export const checkGeneratedTests = async (files: ReadonlyMap<string, string>, readable: boolean): Promise<Finding[]> => {
	if (!readable) return []
	const expected = await expectedGeneratedTests(files)
	if (!expected.ok) return [...expected.findings]
	const findings: Finding[] = []
	for (const [path, { text }] of expected.tests) {
		const present = files.get(path)
		if (present === undefined) findings.push(at(path, 'this generated test is missing'))
		else if (present !== text && !(await failsItsHash(present))) findings.push(at(path, 'this file is not the generated test the scaffold writes here'))
	}
	for (const [path, text] of files) {
		if (text.startsWith(GENERATED_TEST_HEADER) && !expected.tests.has(path)) {
			findings.push(at(path, 'a generated test the scaffold no longer writes'))
		}
	}
	return findings
}
