// The application's shell graph read from disk as Control reads it from a commit, each module as its slice: what both
// SPA build plugins (`bun-plugin.ts`, `vite-plugin.ts`) load in place of the files. The SPA's slice of the module that
// declares the table policies has `tables = {}`: the client never reads them, and their parse would load with them.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseModule } from './ast'
import { contractReaderInputs, readContract, readTablesDeclaration, type TablesDeclaration } from './contract'
import { CONTRACT_FILE, isSourceFile } from './layout'
import { moduleSlice, shellSlice } from './slice'

const SOURCE_EXTENSION = String.raw`\.(?:[mc]?[jt]s|[jt]sx)$`

/** The application's own modules under `root`, outside `node_modules`: every extension the reader reads. */
export const applicationModules = (root: string): RegExp =>
	new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\/](?!(?:.*[\\/])?node_modules[\\/]).*${SOURCE_EXTENSION}`)

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true

/**
 * The shell modules under `root`, by absolute path, as their slices; none without a `fabrika.contract.ts` there.
 * Throws the reader's refusal when the static reader refuses the shell or the table policies.
 */
export function shellModules(root: string): ReadonlyMap<string, string> {
	if (!isFile(join(root, CONTRACT_FILE))) return new Map()
	const files = new Map<string, string>()
	for (;;) {
		const missing = contractReaderInputs(files, (path) => isFile(join(root, path)))
		if (missing.length === 0) break
		for (const path of missing) files.set(path, readFileSync(join(root, path), 'utf8'))
	}
	readContract(files)
	// The policies are refused here as the platform refuses them, instead of by `defineTables` in the browser.
	const tables = readTablesDeclaration(files)
	return new Map(
		[...files]
			.filter(([path]) => isSourceFile(path))
			.map(([path, text]) => [join(root, path), path === tables?.file ? withoutPolicies(path, text, tables) : shellSlice(path, text).text]),
	)
}

/**
 * The slice of the module that declares the policies, its `defineTables(…)(…)` call and what only the call imports
 * blanked, `{}` in the call's place. `defineApp` reads of `tables` only that it is given.
 */
function withoutPolicies(path: string, text: string, tables: TablesDeclaration): string {
	const slice = shellSlice(path, text).text
	const parsed = parseModule(path, slice)
	// The reader has just read the policies from this slice.
	if (!parsed.ok) throw new Error(`${path}: the slice the policies were read from does not parse`)
	const blanked = moduleSlice(parsed.module, slice, [tables.call]).text
	return `${blanked.slice(0, tables.call.start)}{}${blanked.slice(tables.call.start + 2)}`
}
