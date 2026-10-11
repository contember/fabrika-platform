// @fabrika/check/bun-plugin — a Bun build of the SPA that imports `fabrika.contract.ts` without its handlers. The
// typed client needs the contract's values (its paths and output schemas), never a handler or what only a handler
// imports. The plugin reads the shell graph as Control does, refuses the build when the reader refuses it, and loads
// each shell module as its slice; every other module loads as it is.

import type { BunPlugin, Loader } from 'bun'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { contractReaderInputs, readContract } from './contract'
import { CONTRACT_FILE, isSourceFile } from './layout'
import { shellSlice } from './slice'

const SOURCE_EXTENSION = String.raw`\.(?:[mc]?[jt]s|[jt]sx)$`

/** The application's own modules under `root`, outside `node_modules`: every extension the reader reads. */
const applicationModules = (root: string): RegExp =>
	new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\/](?!(?:.*[\\/])?node_modules[\\/]).*${SOURCE_EXTENSION}`)

export interface ShellSliceOptions {
	/** The application's root, where `fabrika.contract.ts` lies; the working directory by default. */
	readonly root?: string
}

/**
 * Loads every module of the application's shell graph as its slice: no `.handle(…)`, and no import only a handler
 * used. The build fails with the reader's findings when the static reader refuses the shell.
 */
export function shellSlicePlugin(options: ShellSliceOptions = {}): BunPlugin {
	return {
		name: 'fabrika-shell-slice',
		setup(build) {
			const root = realpathSync(resolve(options.root ?? process.cwd()))
			let shell: ReadonlyMap<string, string> | undefined
			build.onLoad({ filter: applicationModules(root) }, (args) => {
				shell ??= shellModules(root)
				return { contents: shell.get(args.path) ?? readFileSync(args.path, 'utf8'), loader: loaderOf(args.path) }
			})
		},
	}
}

export default shellSlicePlugin()

const isFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() === true

/** The shell modules under `root`, by absolute path, as their slices; none without a `fabrika.contract.ts` there. */
function shellModules(root: string): ReadonlyMap<string, string> {
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

function loaderOf(path: string): Loader {
	if (path.endsWith('.tsx')) return 'tsx'
	if (path.endsWith('.jsx')) return 'jsx'
	return /\.[mc]?ts$/.test(path) ? 'ts' : 'js'
}
