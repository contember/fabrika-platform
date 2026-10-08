import { ContractSourceError, readTablesSource } from '../contract'
import type { Finding } from '../finding'
import { isolationTests } from '../scaffold'
import { GENERATED_TEST_HEADER, generatedTestHeader } from './tests'

const RESCAFFOLD = 'the files fabrika db test-scaffold writes for the current src/db/tables.ts; run it and commit the result'

const at = (file: string, message: string): Finding => ({ file, line: 1, column: 1, rule: 'generated-test-hash', message, allowed: RESCAFFOLD })

/** Whether the file's first line is the header of the rest; a file whose hash fails is reported by `checkGeneratedTest`. */
const hashMatches = async (text: string): Promise<boolean> => {
	const newline = text.indexOf('\n')
	return newline !== -1 && text.slice(0, newline) === (await generatedTestHeader(text.slice(newline + 1)))
}

/**
 * Every table a store reaches has its isolation test exactly as the scaffold writes it from the current policies: a
 * deleted, stale or orphaned one is a finding. `readable` is false while the literal or trust rules report the
 * tables; otherwise what the reader refuses is reported here, so a `src/db/tables.ts` it cannot read does not silence
 * the check.
 */
export const checkIsolationTests = async (files: ReadonlyMap<string, string>, readable: boolean): Promise<Finding[]> => {
	if (!readable) return []
	let expected: ReadonlyMap<string, string>
	try {
		expected = await isolationTests(readTablesSource(files))
	} catch (error) {
		if (error instanceof ContractSourceError) return [...error.findings]
		throw error
	}
	const findings: Finding[] = []
	for (const [path, text] of expected) {
		const present = files.get(path)
		if (present === undefined) findings.push(at(path, 'the isolation test of this table is missing'))
		else if (present !== text && (await hashMatches(present))) {
			findings.push(at(path, 'this isolation test was written for another policy of its table'))
		}
	}
	for (const [path, text] of files) {
		if (text.startsWith(GENERATED_TEST_HEADER) && !expected.has(path)) {
			findings.push(at(path, 'a generated isolation test of no table a store reaches'))
		}
	}
	return findings
}
