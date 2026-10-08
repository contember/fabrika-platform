// The generated entrypoint passes the checker that refuses `process.env` everywhere else, and lands where the checker
// expects it.

import {
	CONTRACT_FILE as BUILT_CONTRACT_FILE,
	type EntryRuntime,
	GENERATED_ENTRY_FILE,
	generatedEntry,
	writeGeneratedEntry,
} from '@fabrika/app/build'
import { checkApplication, CONTRACT_FILE, GENERATED_ENTRY_FILE as CHECKED_ENTRY_FILE } from '@fabrika/check'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtures = join(import.meta.dir, 'fixtures', 'implement')

/** The fixture application laid out as an application root, with the entrypoint for `runtime`. */
function applicationFiles(runtime: EntryRuntime): Map<string, string> {
	const read = (file: string) => readFileSync(join(fixtures, file), 'utf8')
	return new Map([
		[CONTRACT_FILE, read('fabrika.contract.ts')],
		['src/app.ts', `${read('app.ts').replace("from './fabrika.contract'", "from '../fabrika.contract'")}\nexport default notesApp(new Map())\n`],
		['src/stores.ts', read('stores.ts')],
		[GENERATED_ENTRY_FILE, generatedEntry(runtime)],
	])
}

describe('the generated entrypoint', () => {
	test('is the file the checker exempts from the environment rule', () => {
		expect(GENERATED_ENTRY_FILE).toBe(CHECKED_ENTRY_FILE)
		expect(BUILT_CONTRACT_FILE).toBe(CONTRACT_FILE)
	})

	const runtimes: readonly EntryRuntime[] = ['bun', 'cloudflare']
	for (const runtime of runtimes) {
		test(`an application with the ${runtime} entrypoint has no finding`, async () => {
			expect(await checkApplication({ root: fixtures, files: applicationFiles(runtime) })).toEqual([])
		})
	}

	test('the same process.env read anywhere else is a finding', async () => {
		const files = applicationFiles('bun')
		files.set('src/server.ts', generatedEntry('bun'))
		const findings = await checkApplication({ root: fixtures, files })
		expect(findings.map((finding) => `${finding.file} ${finding.rule}`)).toContain('src/server.ts env-read')
	})

	test('is written under the application root', async () => {
		const root = mkdtempSync(join(tmpdir(), 'fabrika-entry-'))
		try {
			const path = await writeGeneratedEntry(root, 'cloudflare')
			expect(path).toBe(join(root, 'fabrika', 'entry.generated.ts'))
			expect(readFileSync(path, 'utf8')).toBe(generatedEntry('cloudflare'))
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
