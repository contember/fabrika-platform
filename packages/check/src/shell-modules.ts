// The application's shell graph read from disk as Control reads it from a commit, each module as its slice: what both
// SPA build plugins (`bun-plugin.ts`, `vite-plugin.ts`) load in place of the files.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contractReaderInputs, readContract } from './contract'
import { CONTRACT_FILE, isSourceFile } from './layout'
import { shellSlice } from './slice'

const SOURCE_EXTENSION = String.raw`\.(?:[mc]?[jt]s|[jt]sx)$`

/** The application's own modules under `root`, outside `node_modules`: every extension the reader reads. */
export const applicationModules = (root: string): RegExp =>
	new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\/](?!(?:.*[\\/])?node_modules[\\/]).*${SOURCE_EXTENSION}`)

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true

/**
 * The shell modules under `root`, by absolute path, as their slices; none without a `fabrika.contract.ts` there.
 * Throws the reader's refusal when the static reader refuses the shell.
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
	return new Map([...files].filter(([path]) => isSourceFile(path)).map(([path, text]) => [join(root, path), shellSlice(path, text).text]))
}
