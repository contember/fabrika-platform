/** Where an application keeps what the checker reads. Paths are relative to the application root. */
export const CONTRACT_FILE = 'fabrika.contract.ts'
/** The provider-authored application config, whose `defineApp` names the provider. */
export const CONFIG_FILE = 'fabrika.config.ts'
/** The named export of the contract module that holds `defineContract(…)`. */
export const CONTRACT_EXPORT = 'contract'
export const TABLES_FILE = 'src/db/tables.ts'
/** The named export of the tables module that holds `defineTables(…)(…)`. */
export const TABLES_EXPORT = 'tables'
export const GENERATED_ENTRY_FILE = 'fabrika/entry.generated.ts'
/** Where a Cloudflare deploy stages the SPA mounts' built files (`@fabrika/provider-cloudflare`): build output, never source. */
export const STAGED_ASSETS_DIR = 'fabrika/assets/'
export const MIGRATIONS_DIR = 'db/migrations/'
/** Where `fabrika db test-scaffold` writes the policy isolation tests, `<table>.policy-isolation.test.ts`. */
export const POLICY_TESTS_DIR = 'src/db/__tests__/'
export const POLICY_TEST_SUFFIX = '.policy-isolation.test.ts'
/** The generated endpoint access tests; they import `src/app.ts`, whose default export they boot. */
export const ENDPOINT_ACCESS_TEST = 'src/__tests__/endpoint-access.test.ts'
/** The inputs the author gives the endpoint access tests where the scaffold cannot sample one; read, never run. */
export const ENDPOINT_FIXTURES_FILE = 'src/__tests__/endpoint-access.fixtures.ts'
export const ZEROPS_FILES = ['zerops.yaml', 'zerops.yml'] as const

/** The application architecture (docs/reference/application-architecture.md): where each layer's code lives. */
export const VOCABULARY_FILE = 'src/vocabulary.ts'
export const APP_KIT_FILE = 'src/app-kit.ts'
/** The shared zod schemas the shell and the SPA import: one module, or a directory of them once it grows. */
export const SCHEMAS_FILE = 'src/schemas.ts'
export const SCHEMAS_DIR = 'src/schemas/'
/** Pure code the SPA and every slice may import: it loads nothing but `zod/v4` and other modules of its own directory. */
export const SHARED_DIR = 'src/shared/'
/** `src/db/`: the tables, the generated schema and their generated tests; never a slice. */
export const DATABASE_DIR = 'src/db/'
/** A slice is a directory `src/<slice>/` that holds these modules, each optional. */
export const SLICE_ENDPOINTS_FILE = 'endpoints.ts'
export const SLICE_LOGIC_FILE = 'logic.ts'
export const SLICE_QUERIES_FILE = 'queries.ts'
export const SPA_DIR = 'web/'
/** The server half of an application: its modules run in the application's process. */
export const SERVER_DIR = 'src/'

const SOURCE_EXTENSION = /\.(?:[mc]?[jt]s|[jt]sx)$/
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[mc]?[jt]sx?$/

/** Build output, installed packages and tool state are not application source and are never read. */
export const isIgnoredSegment = (segment: string): boolean => segment === 'node_modules' || segment === 'dist' || segment.startsWith('.')

/** Whether the checker skips `path` (relative to the root): under a skipped segment, or the staged SPA files. */
export const isSkippedPath = (path: string): boolean => path.split('/').some(isIgnoredSegment) || path.startsWith(STAGED_ASSETS_DIR)

export const isSourceFile = (path: string): boolean => SOURCE_EXTENSION.test(path)

export const isTestFile = (path: string): boolean => TEST_FILE.test(path)

/** A module that runs in the application's server process: under `src/`, not a test. */
export const isServerModule = (path: string): boolean => path.startsWith(SERVER_DIR) && !isTestFile(path)

export const isJsonFile = (path: string): boolean => path.endsWith('.json')

/** Whether the checker reads this file at all. */
export const isCheckedFile = (path: string): boolean => {
	// The registry configuration and the lockfile decide what a trusted package name installs.
	if (path === '.npmrc' || path === 'bun.lock') return true
	if (isSkippedPath(path)) return false
	return isSourceFile(path) || isJsonFile(path) || path.startsWith(MIGRATIONS_DIR) || ZEROPS_FILES.some((name) => name === path)
		|| path === 'bunfig.toml'
}

/** Joins a relative specifier onto the importing file's directory; `undefined` when it climbs above the root. */
export const joinRelative = (fromFile: string, specifier: string): string | undefined => {
	const segments = fromFile.split('/').slice(0, -1)
	for (const part of specifier.split('/')) {
		if (part === '.' || part === '') continue
		if (part === '..') {
			if (segments.length === 0) return undefined
			segments.pop()
		} else segments.push(part)
	}
	return segments.join('/')
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const SCRIPT_TO_SOURCE: Readonly<Record<string, string>> = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' }

/** The files Bun tries for a relative import of `base` after the name itself: each source extension, a script's source. */
const fileCandidates = (base: string): readonly string[] => {
	const candidates = SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`)
	for (const [script, source] of Object.entries(SCRIPT_TO_SOURCE)) {
		if (base.endsWith(script)) candidates.push(`${base.slice(0, -script.length)}${source}`)
	}
	return candidates
}

/** What makes `base` a directory import: an index file, or a `package.json` whose entry point Bun would follow. */
const directoryCandidates = (base: string): readonly string[] => [
	...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
	`${base}/package.json`,
]

/**
 * How a relative import resolves among the files that exist. Only an exact name, or exactly one extension candidate,
 * is a `file`: with two candidates (`m.ts` and `m.tsx`) or a directory, Bun's choice is not one the checker repeats.
 */
export type Resolution =
	| { readonly kind: 'file'; readonly path: string }
	| { readonly kind: 'ambiguous'; readonly paths: readonly string[] }
	| { readonly kind: 'directory'; readonly paths: readonly string[] }
	| { readonly kind: 'missing' }

export const resolveRelative = (exists: (path: string) => boolean, fromFile: string, specifier: string): Resolution => {
	const base = joinRelative(fromFile, specifier)
	if (base === undefined) return { kind: 'missing' }
	if (base !== '' && exists(base)) return { kind: 'file', path: base }
	const files = fileCandidates(base).filter(exists)
	const [only, ...more] = files
	if (only !== undefined && more.length === 0) return { kind: 'file', path: only }
	if (only !== undefined) return { kind: 'ambiguous', paths: files }
	const directory = directoryCandidates(base).filter(exists)
	return directory.length === 0 ? { kind: 'missing' } : { kind: 'directory', paths: directory }
}

export const isRelativeSpecifier = (specifier: string): boolean =>
	specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
