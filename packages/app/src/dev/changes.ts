// What a sync changes, read off its paths: whether the build owns one (then the commit needs a bootstrap run), whether
// the migrations changed, and whether a web source did. Whether the contract changed is the digest's to say, not a path's.

import { CONTRACT_FILE } from '../build.js'

/** The application's migrations, as `fabrika db migrate` reads them. */
export const MIGRATIONS_DIRECTORY = 'db/migrations/'

/** Files whose change the build turns into something else: an install, or the generated run and build descriptors. */
const BUILD_OWNED_FILES: ReadonlySet<string> = new Set(['package.json', 'bun.lock', 'bun.lockb', 'bunfig.toml', 'zerops.yaml', 'zerops.yml'])
const BUILD_OWNED_DIRECTORIES = ['fabrika/', 'node_modules/'] as const

/** Server code and the database: a change only there leaves the SPA as it is. */
const SERVER_DIRECTORIES = ['src/', 'db/'] as const

/** Why the change needs a bootstrap run, in one line, or null when the launcher may apply it. */
export function bootstrapReason(paths: readonly string[]): string | null {
	for (const path of paths) {
		const why = BUILD_OWNED_FILES.has(path)
			? 'the dependencies, the lockfile or the build descriptor'
			: BUILD_OWNED_DIRECTORIES.some((directory) => path.startsWith(directory))
			? 'the generated files or the installed packages'
			: path !== CONTRACT_FILE && path.startsWith('fabrika.') && !path.includes('/')
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
