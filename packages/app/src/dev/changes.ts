// What a sync changes, read off its paths: whether the build owns one (then the commit needs a bootstrap run), whether
// the migrations changed, and whether a web source did. Pure: the caller reads the files.

import { posix } from 'node:path'
import { CONTRACT_FILE } from '../build.js'

/** The application's migrations, as `fabrika db migrate` reads them. */
export const MIGRATIONS_DIRECTORY = 'db/migrations/'

/** Files whose change the build turns into something else: an install, the contract digest and proxy table, a generated file. */
const BUILD_OWNED_FILES: ReadonlySet<string> = new Set(['package.json', 'bun.lock', 'bun.lockb', 'bunfig.toml', 'zerops.yaml', 'zerops.yml'])
const BUILD_OWNED_DIRECTORIES = ['fabrika/', 'node_modules/'] as const

/** Server code and the database: a change only there leaves the SPA as it is. */
const SERVER_DIRECTORIES = ['src/', 'db/'] as const

/** Reads a file at the head the sync brings, or null when it does not exist there. */
export type SourceReader = (path: string) => string | null

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g

/** The repository paths a relative specifier of `from` may name, in the order Bun resolves a TypeScript import. */
function candidates(from: string, specifier: string): string[] {
	const base = posix.normalize(posix.join(posix.dirname(from), specifier))
	if (base.startsWith('../')) return []
	const withoutJs = base.endsWith('.js') ? base.slice(0, -3) : base
	return [base, `${withoutJs}.ts`, `${withoutJs}.tsx`, `${withoutJs}/index.ts`]
}

/** `fabrika.contract.ts` and every module it reaches by a relative import, read through `read`. */
export function contractModules(read: SourceReader): Set<string> {
	const modules = new Set<string>()
	const pending = [CONTRACT_FILE]
	while (pending.length > 0) {
		const path = pending.pop() ?? ''
		if (modules.has(path)) continue
		const text = read(path)
		if (text === null) continue
		modules.add(path)
		for (const match of text.matchAll(RELATIVE_IMPORT)) {
			const resolved = candidates(path, match[1] ?? '').find((candidate) => read(candidate) !== null)
			if (resolved !== undefined) pending.push(resolved)
		}
	}
	return modules
}

/**
 * Why the change needs a bootstrap run, in one line, or null when the launcher may apply it. `before` reads the
 * container's files, `after` the files at the target: a module the contract imports at either counts.
 */
export function bootstrapReason(paths: readonly string[], before: SourceReader, after: SourceReader): string | null {
	const contract = new Set([...contractModules(before), ...contractModules(after)])
	for (const path of paths) {
		const why = BUILD_OWNED_FILES.has(path)
			? 'the dependencies, the lockfile or the build descriptor'
			: BUILD_OWNED_DIRECTORIES.some((directory) => path.startsWith(directory))
			? 'the generated files or the installed packages'
			: contract.has(path)
			? 'the contract or a module it imports (its digest and the proxy table change)'
			: path.startsWith('fabrika.') && !path.includes('/')
			? 'a fabrika.* file'
			: null
		if (why !== null) return `${path} changed, which is ${why}; that needs a bootstrap run: call bind_dev again`
	}
	return null
}

export const migrationsChanged = (paths: readonly string[]): boolean => paths.some((path) => path.startsWith(MIGRATIONS_DIRECTORY))

/** A change outside the server code and the database may reach the SPA, so its build runs again. */
export const webSourceChanged = (paths: readonly string[]): boolean =>
	paths.some((path) => !SERVER_DIRECTORIES.some((directory) => path.startsWith(directory)))
