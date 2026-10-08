/** Where an application keeps what the checker reads. Paths are relative to the application root. */
export const CONTRACT_FILE = 'fabrika.contract.ts'
export const TABLES_FILE = 'src/db/tables.ts'
export const GENERATED_ENTRY_FILE = 'fabrika/entry.generated.ts'
export const MIGRATIONS_DIR = 'db/migrations/'
export const ZEROPS_FILES = ['zerops.yaml', 'zerops.yml'] as const

const SOURCE_EXTENSION = /\.(?:[mc]?[jt]s|[jt]sx)$/
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[mc]?[jt]sx?$/

/** Build output, installed packages and tool state are not application source and are never read. */
export const isIgnoredSegment = (segment: string): boolean => segment === 'node_modules' || segment === 'dist' || segment.startsWith('.')

export const isSourceFile = (path: string): boolean => SOURCE_EXTENSION.test(path)

export const isTestFile = (path: string): boolean => TEST_FILE.test(path)

/** Whether the checker reads this file at all. */
export const isCheckedFile = (path: string): boolean => {
	if (path.split('/').some(isIgnoredSegment)) return false
	return isSourceFile(path) || path.startsWith(MIGRATIONS_DIR) || ZEROPS_FILES.some((name) => name === path)
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

const SCRIPT_TO_SOURCE: Readonly<Record<string, string>> = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' }

/** The candidates TypeScript's bundler resolution tries for a relative import of `base`. */
export const resolutionCandidates = (base: string): readonly string[] => {
	const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
	for (const [script, source] of Object.entries(SCRIPT_TO_SOURCE)) {
		if (base.endsWith(script)) candidates.push(`${base.slice(0, -script.length)}${source}`)
	}
	return candidates
}

export const isRelativeSpecifier = (specifier: string): boolean =>
	specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
