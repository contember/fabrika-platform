// @fabrika/check/vite-plugin — a Vite build (or dev server) of the SPA that imports `fabrika.contract.ts` without its
// handlers, as `@fabrika/check/bun-plugin` does for `Bun.build`. It loads each module of the shell graph as its slice
// and leaves every other module to Vite; the build fails when the static reader refuses the shell. The package ships
// TypeScript, so the Vite that loads this plugin runs on Bun (`bun --bun vite build`).

import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { CONTRACT_FILE } from './layout'
import { applicationModules, shellModules } from './shell-modules'

export interface ShellSliceOptions {
	/** The application's root, where `fabrika.contract.ts` lies; the working directory by default. */
	readonly root?: string
}

/** What the plugin uses of Vite's plugin context. */
export interface WatchContext {
	addWatchFile(id: string): void
}

/** The part of Vite's `Plugin` this plugin implements; a value of it goes into `plugins` as it is. */
export interface ShellSliceVitePlugin {
	readonly name: string
	readonly enforce: 'pre'
	/**
	 * A shell module's slice, its file watched; `null` leaves the module to Vite's own load. Throws for a
	 * `fabrika.contract.ts` that is not the root's: Vite would bundle it, handlers included.
	 */
	load(this: WatchContext, id: string): { readonly code: string } | null
	/** Any change of a watched file: the next load reads the shell graph again. */
	watchChange(): void
}

/**
 * Loads every module of the application's shell graph as its slice: no `.handle(…)`, and no import only a handler
 * used. The build fails with the reader's findings when the static reader refuses the shell.
 */
export function shellSlicePlugin(options: ShellSliceOptions = {}): ShellSliceVitePlugin {
	const root = realpathSync(resolve(options.root ?? process.cwd()))
	const modules = applicationModules(root)
	let shell: ReadonlyMap<string, string> | undefined
	return {
		name: 'fabrika-shell-slice',
		enforce: 'pre',
		load(id) {
			// Vite's id is the file's real path, with a query for a variant (`?raw`, `?url`), which gets the slice too.
			const path = id.split('?', 1)[0] ?? id
			const contract = basename(path) === CONTRACT_FILE
			if (!contract && !modules.test(path)) return null
			shell ??= shellModules(root)
			const code = shell.get(path)
			if (code === undefined && contract) {
				throw new Error(`${path} is not the contract of the plugin's root ${root}: pass shellSlicePlugin({ root }) the application's root`)
			}
			if (code === undefined) return null
			// Vite watches only its root and the files it loads itself; the shell lies beside `web/`.
			this.addWatchFile(path)
			return { code }
		},
		watchChange() {
			shell = undefined
		},
	}
}
