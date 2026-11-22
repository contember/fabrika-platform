// @fabrika/check/bun-plugin — a Bun build of the SPA that imports `fabrika.contract.ts` without its handlers. The
// typed client needs the contract's values (its paths and output schemas), never a handler or what only a handler
// imports. The plugin reads the shell graph as Control does, refuses the build when the reader refuses it, and loads
// each shell module as its slice; every other module loads as it is. `@fabrika/check/vite-plugin` is the same for Vite.

import type { BunPlugin, Loader } from 'bun'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { applicationModules, shellModules } from './shell-modules'

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

function loaderOf(path: string): Loader {
	if (path.endsWith('.tsx')) return 'tsx'
	if (path.endsWith('.jsx')) return 'jsx'
	return /\.[mc]?ts$/.test(path) ? 'ts' : 'js'
}
