// Which files of an application the static reader needs. Control reads a commit file by file, and the reader cannot
// tell a missing file from one it was not given, so the caller asks here until nothing is missing. Worker-safe.

import { importedSpecifiers } from './ast'
import { parseJsonc } from './jsonc'
import { CONTRACT_FILE, isRelativeSpecifier, isSourceFile, joinRelative, resolveRelative, TABLES_FILE } from './layout'
import { parseShellModule } from './slice'
import { BUNFIG_FILE } from './trust'

const RESOLUTION_CONFIGS = ['package.json', 'tsconfig.json', 'jsconfig.json']
const TSCONFIG_NAMES = ['tsconfig.json', 'jsconfig.json']

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const inDirectory = (directory: string, name: string): string => (directory === '' ? name : `${directory}/${name}`)

/** The root and every directory above the file, outermost first. */
const directoriesOf = (path: string): string[] => {
	const segments = path.split('/').slice(0, -1)
	return ['', ...segments.map((_, index) => segments.slice(0, index + 1).join('/'))]
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The paths `readContractSource` reads that `files` does not hold yet, among the paths that `exists` at the commit:
 * `fabrika.contract.ts` and `src/db/tables.ts`, every module the shell slice of each imports (an import only a
 * colocated handler uses is never followed) with every candidate of an import, the
 * `package.json`, `tsconfig.json` and `jsconfig.json` of each such module's directories, a root `bunfig.toml`, and the
 * files a `tsconfig.json` extends. A module is followed only once its text is in `files`, so the caller reads the answer,
 * adds it to `files` and asks again until the answer is empty.
 */
export function contractReaderInputs(files: ReadonlyMap<string, string>, exists: (path: string) => boolean): string[] {
	const needed = new Set<string>()
	const want = (path: string): void => {
		if (exists(path) && !files.has(path)) needed.add(path)
	}
	want(BUNFIG_FILE)
	const visited = new Set<string>()
	const queue = [CONTRACT_FILE, TABLES_FILE].filter(exists)
	for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
		if (visited.has(path)) continue
		visited.add(path)
		for (const directory of directoriesOf(path)) {
			for (const name of RESOLUTION_CONFIGS) want(inDirectory(directory, name))
		}
		const text = files.get(path)
		if (text === undefined) {
			want(path)
			continue
		}
		const parsed = isSourceFile(path) ? parseShellModule(path, text) : undefined
		if (parsed?.ok !== true) continue
		for (const specifier of importedSpecifiers(parsed.module)) {
			if (!isRelativeSpecifier(specifier)) continue
			const resolution = resolveRelative(exists, path, specifier)
			const targets = resolution.kind === 'file' ? [resolution.path] : resolution.kind === 'missing' ? [] : resolution.paths
			for (const target of targets) {
				if (isSourceFile(target)) queue.push(target)
				else want(target)
			}
		}
	}
	for (const extended of extendedConfigs(files)) want(extended)
	return [...needed].sort()
}

/** Every candidate of a relative `extends`, followed from each `tsconfig.json` and `jsconfig.json` in `files`. */
function extendedConfigs(files: ReadonlyMap<string, string>): string[] {
	const candidates: string[] = []
	const visited = new Set<string>()
	const queue = [...files.keys()].filter((path) => TSCONFIG_NAMES.includes(baseName(path)))
	for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
		const text = files.get(path)
		if (visited.has(path) || text === undefined) continue
		visited.add(path)
		const config = parseJsonc(text)
		const extended = isRecord(config) ? config['extends'] : undefined
		const targets = typeof extended === 'string' ? [extended] : Array.isArray(extended) ? extended : []
		for (const target of targets) {
			const base = typeof target === 'string' && isRelativeSpecifier(target) ? joinRelative(path, target) : undefined
			if (base === undefined) continue
			candidates.push(base, `${base}.json`)
			queue.push(base, `${base}.json`)
		}
	}
	return candidates
}
