import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileProject } from '../src/platform-source'

const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const href = (path: string): string => JSON.stringify(pathToFileURL(join(import.meta.dir, path)).href)

const lockfile = (version: number): string =>
	`{\n  "lockfileVersion": ${version},\n  "workspaces": {\n    "": {\n      "name": "notes",\n    },\n  },\n}\n`

/** A contract application's root on `base`, with a `bun.lock` of `version` unless null, and the state directory beside it. */
function project(base: string, version: number | null): { readonly root: string; readonly state: string } {
	// The real path: the compile refuses a symbolic link anywhere in the state directory's path.
	const directory = mkdtempSync(join(realpathSync(tmpdir()), 'fabrika-builder-compile-'))
	directories.push(directory)
	const root = join(directory, 'app')
	const state = join(directory, 'state')
	for (const path of [root, state]) mkdirSync(path, { mode: 0o700 })
	writeFileSync(
		join(root, 'fabrika.config.ts'),
		[
			`import { defineApp } from ${JSON.stringify(import.meta.resolve('@fabrika/provider-zerops'))}`,
			`import { contractProxyTable } from ${href('../../../proxy-core/src/manifest.ts')}`,
			`import { notesArtifact } from ${href('../../../auth-core/src/__tests__/fixtures/notes-artifact.ts')}`,
			"export default defineApp({ id: 'notes', target: { platform: 'zerops', services: () => [{ hostname: 'notesapi', type: 'alpine/bun@1.3' }],",
			"  deployService: 'notesapi', contract: notesArtifact, proxy: { upstream: 'notesapi:3000', ...contractProxyTable(notesArtifact) } } })",
			'',
		].join('\n'),
	)
	writeFileSync(join(root, 'zerops.yaml'), `zerops:\n  - setup: notesapi\n    build:\n      base: ${base}\n`)
	if (version !== null) writeFileSync(join(root, 'bun.lock'), lockfile(version))
	return { root, state }
}

describe('the builder compile against the repository bun.lock', () => {
	test('refuses a build base that cannot read it, with the refusal the deployment shows', async () => {
		const { root, state } = project('alpine/bun@1.3', 2)
		await expect(compileProject(root, 'prod', 'notes', state, new AbortController().signal)).rejects.toThrow(
			'bun.lock has lockfileVersion 2, which Bun 1.3 cannot read',
		)
	})

	test('compiles on a base that reads it, and without a bun.lock', async () => {
		const reads = project('alpine/bun@1.4', 2)
		expect((await compileProject(reads.root, 'prod', 'notes', reads.state, new AbortController().signal)).app.id).toBe('notes')
		const none = project('alpine/bun@1.3', null)
		expect((await compileProject(none.root, 'prod', 'notes', none.state, new AbortController().signal)).app.id).toBe('notes')
	})
})
