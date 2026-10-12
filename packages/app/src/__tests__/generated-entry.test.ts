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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtures = join(import.meta.dir, 'fixtures', 'implement')

/** A kit application without tables, laid out as an application root, with the entrypoint for `runtime`. */
function applicationFiles(runtime: EntryRuntime): Map<string, string> {
	return new Map([
		[
			'src/vocabulary.ts',
			"import { defineVocabulary } from '@fabrika/app/contract'\n\nexport const vocabulary = defineVocabulary({ app: 'notes', dimensions: { workspace: {} }, actions: { 'notes.read': 'Read notes' }, roles: { reader: { grants: ['notes.read'] } } })\n",
		],
		[
			'src/app-kit.ts',
			"import { defineApp } from '@fabrika/app/contract'\nimport { vocabulary } from './vocabulary'\n\nexport const app = defineApp(vocabulary)\n",
		],
		[
			'src/notes/endpoints.ts',
			"import { z } from 'zod/v4'\nimport { app } from '../app-kit'\n\nexport const notes = app.group({ callers: ['human'] }, (r) => ({\n\treadable: r.query({ output: z.strictObject({ all: z.boolean() }), access: { action: 'notes.read', over: 'workspace' } })\n\t\t.handle(({ ctx }) => ({ all: ctx.within.values === 'all' })),\n}))\n",
		],
		[
			CONTRACT_FILE,
			"import { app } from './src/app-kit'\nimport { notes } from './src/notes/endpoints'\n\nexport const contract = app.contract((c) => ({ api: c.rpc('/api', { notes }), health: c.health('/healthz') }))\n",
		],
		[
			'src/app.ts',
			"import { serve } from '@fabrika/app/implement'\nimport { contract } from '../fabrika.contract'\n\nexport default serve(contract, { database: null })\n",
		],
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

describe('a process the generated entrypoint serves from', () => {
	const root = join(import.meta.dir, 'production-load')

	for (const kit of ['@fabrika/db/testing', '@fabrika/app/testing', '@fabrika/app/testing/isolation']) {
		test(`refuses ${kit} although the framework scrubbed FABRIKA_RELEASE`, async () => {
			mkdirSync(join(root, 'fabrika'), { recursive: true })
			writeFileSync(join(root, GENERATED_ENTRY_FILE), generatedEntry('bun'))
			try {
				const child = Bun.spawn(['bun', GENERATED_ENTRY_FILE], {
					cwd: root,
					env: { PATH: process.env['PATH'] ?? '', FABRIKA_RELEASE: 'r1', PRODUCTION_LOAD_KIT: kit },
					stdout: 'pipe',
					stderr: 'pipe',
				})
				const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
				expect(code).not.toBe(0)
				expect(stderr).toContain('is a test helper; this process serves an application')
			} finally {
				rmSync(join(root, 'fabrika'), { recursive: true, force: true })
			}
		})
	}
})
