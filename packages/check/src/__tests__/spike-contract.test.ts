import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkApplication } from '../check'
import { locations } from './helpers'

// The parser spike's sample application, kept as `.fixture` files so that the repository's own tools leave it alone.
const FIXTURE = join(import.meta.dir, 'fixtures', 'spike-contract')

const readFixture = async (): Promise<ReadonlyMap<string, string>> => {
	const files = new Map<string, string>()
	for (const entry of await readdir(FIXTURE, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue
		const path = join(entry.parentPath, entry.name)
		files.set(path.slice(FIXTURE.length + 1).replace(/\.fixture$/, ''), await readFile(path, 'utf8'))
	}
	return files
}

describe('the parser spike sample contract', () => {
	test('yields the 14 literal findings the spike measured, at the same positions, and the import of the non-literal readRoles', async () => {
		const findings = await checkApplication({ root: FIXTURE, files: await readFixture() })

		expect(locations(findings, 'literal')).toEqual([
			// The spike validated imports only where a value used them; every runtime import is validated now.
			'fabrika.contract.ts:4:10',
			'fabrika.contract.ts:7:1',
			'fabrika.contract.ts:20:3',
			'fabrika.contract.ts:23:3',
			'fabrika.contract.ts:32:10',
			'fabrika.contract.ts:34:47',
			'fabrika.contract.ts:34:58',
			'fabrika.contract.ts:36:13',
			'fabrika.contract.ts:37:67',
			'fabrika.contract.ts:48:23',
			'fabrika.contract.ts:57:12',
			'fabrika.contract.ts:62:49',
			'src/roles.ts:1:1',
			'src/schemas/notes.ts:17:38',
			'src/schemas/notes.ts:18:24',
		])
	})

	test('the other rules report what they own in the same files', async () => {
		const findings = await checkApplication({ root: FIXTURE, files: await readFixture() })

		expect(
			findings.filter((finding) => finding.rule !== 'literal').map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule}`),
		)
			.toEqual(['fabrika.contract.ts:37:67 type-assertion', 'fabrika.contract.ts:48:23 env-read'])
	})
})
