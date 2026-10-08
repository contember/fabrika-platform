// Every form `defineContract` accepts in a fixture is a literal to `@fabrika/check`, so the platform can later read
// these contracts from source. The mistakes are type errors; the two loose objects are refused by the checker too.

import { checkApplication, CONTRACT_FILE } from '@fabrika/check'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const notesApp = join(import.meta.dir, 'fixtures', 'notes-app')
const mistakesDir = join(import.meta.dir, 'contract-mistakes')

/** The literal-rule message for the mistakes the checker refuses as well. */
const CHECKER_REFUSES: Readonly<Record<string, string>> = {
	'11-loose-input.ts': "'.loose()' makes the schema unserializable",
	'15-loose-output.ts': "'.passthrough()' makes the schema unserializable",
}

describe('the fixture contracts are literals', () => {
	test('the notes application has no finding at all', async () => {
		const findings = await checkApplication({ root: notesApp })
		expect(findings).toEqual([])
	})

	for (const file of readdirSync(mistakesDir)) {
		test(`contract-mistakes/${file} is a literal unless the checker refuses its mistake`, async () => {
			const findings = await checkApplication({
				root: mistakesDir,
				files: new Map([[CONTRACT_FILE, readFileSync(join(mistakesDir, file), 'utf8')]]),
			})
			const refused = CHECKER_REFUSES[file]
			expect(findings.filter((finding) => finding.rule === 'literal').map((finding) => finding.message)).toEqual(refused === undefined ? [] : [refused])
		})
	}
})
