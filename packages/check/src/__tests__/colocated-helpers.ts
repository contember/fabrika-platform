// Shared by the tests of the shell slice: an application as Control reads it from a commit, the files Control asks
// for, and the same files written out and evaluated by Bun. Not a `*.test.ts`, so bun does not run it.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { z } from 'zod/v4'
import { contractReaderInputs } from '../contract'

/** `@fabrika/app`'s staged-kit fixture: a CRM whose groups, jobs, webhook, link and export each sit in their module. */
export const KIT_ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'kit-fixture')

/** WU1's two-slice application in the target layout, its sources named `*.ts.fixture`. */
export const ARCHITECTURE_ROOT = join(import.meta.dir, 'fixtures', 'architecture-app')

const PACKAGE_ROOT = join(import.meta.dir, '..', '..')
const RUNNER = join(import.meta.dir, 'fixtures', 'paired-runner.mjs')
const BUILDER = join(import.meta.dir, 'fixtures', 'plugin-build.mjs')

/** Every file under `root` with one of `suffixes`, by its path relative to `root`, a `.fixture` suffix dropped. */
export const readTree = (root: string, suffixes: readonly string[] = ['.ts']): Map<string, string> => {
	const files = new Map<string, string>()
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
			const path = join(entry.parentPath, entry.name)
			files.set(relative(root, path).replace(/\.fixture$/, ''), readFileSync(path, 'utf8'))
		}
	}
	return files
}

/** What Control fetches of a commit: only the paths `contractReaderInputs` names, round by round. */
export const fetchedByControl = (commit: ReadonlyMap<string, string>): Map<string, string> => {
	const files = new Map<string, string>()
	for (;;) {
		const missing = contractReaderInputs(files, (path) => commit.has(path))
		if (missing.length === 0) return files
		for (const path of missing) files.set(path, commit.get(path) ?? '')
	}
}

const temporary: string[] = []

/** Removes every directory `materialize` wrote; each test file that materializes runs it `afterAll`. */
export const removeMaterialized = (): void => {
	for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
}

/** The files written under the package, so that Bun resolves zod and the framework from its node_modules. */
export const materialize = (files: ReadonlyMap<string, string>): string => {
	const directory = mkdtempSync(join(PACKAGE_ROOT, '.colocated-'))
	temporary.push(directory)
	for (const [path, text] of files) {
		mkdirSync(dirname(join(directory, path)), { recursive: true })
		writeFileSync(join(directory, path), text)
	}
	return directory
}

const evaluation = z.union([z.strictObject({ ok: z.literal(true), json: z.string() }), z.strictObject({ ok: z.literal(false), error: z.string() })])

/** Bun evaluates `entry` and prints the canonical artifact of its contract against `tables`' policies, or what it threw. */
export const evaluateInBun = (entry: string, tables?: string): z.infer<typeof evaluation> => {
	const run = Bun.spawnSync([process.execPath, RUNNER, entry, ...(tables === undefined ? [] : [tables])], { cwd: dirname(entry) })
	return evaluation.parse(JSON.parse(run.stdout.toString()))
}

const built = z.strictObject({ ok: z.boolean(), error: z.string() })

/**
 * Builds `entry` of the application at `root` through the shell slice plugin into `root/out`, in a process of its own;
 * `external` packages stay imports.
 */
export const buildWithPlugin = (
	root: string,
	entry: string,
	options: { readonly target?: 'browser' | 'bun'; readonly external?: readonly string[] } = {},
): z.infer<typeof built> => {
	const run = Bun.spawnSync([
		process.execPath,
		BUILDER,
		root,
		join(root, entry),
		join(root, 'out'),
		options.target ?? 'browser',
		(options.external ?? []).join(','),
	], { cwd: root })
	return built.parse(JSON.parse(run.stdout.toString()))
}
