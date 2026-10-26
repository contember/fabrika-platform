import { isBuiltin } from 'node:module'
import { z } from 'zod/v4'
import { parseJsonc } from './jsonc'
import { isRelativeSpecifier, isSkippedPath, joinRelative, resolveRelative } from './layout'

/** Pattern → targets. A target is a bare specifier, an absolute path, or `./<path from the root>` (`../…` above it). */
type MappingTable = ReadonlyMap<string, readonly string[]>

/**
 * The application's own import mappings, as Bun applies them to one module: `compilerOptions.paths` of the nearest
 * `tsconfig.json` (or `jsconfig.json`), with its local `extends`, then `imports` of the nearest `package.json`.
 */
export interface ImportMappings {
	readonly paths: (file: string) => MappingTable
	readonly imports: (file: string) => MappingTable
	/** Whether Bun may find a module at a target; one outside what the checker reads counts, so a rule still sees it. */
	readonly mayExist: (target: string) => boolean
}

const packageJsonSchema = z.object({ imports: z.record(z.string(), z.unknown()).optional() })
const tsconfigSchema = z.object({
	extends: z.union([z.string(), z.array(z.string())]).optional(),
	compilerOptions: z.object({ baseUrl: z.string().optional(), paths: z.record(z.string(), z.array(z.string())).optional() }).optional(),
})

const TSCONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'] as const
const EMPTY: MappingTable = new Map()

/** Every target string of an import-map value, through its condition objects and fallback arrays. */
const targetStrings = (value: unknown): string[] => {
	if (typeof value === 'string') return [value]
	if (Array.isArray(value)) return value.flatMap(targetStrings)
	if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(targetStrings)
	return []
}

/** The directories a module's configuration is looked up in, nearest first: `src/a/b.ts` → `src/a`, `src`, the root. */
const directoriesAbove = (file: string): readonly string[] => {
	const segments = file.split('/').slice(0, -1)
	const directories: string[] = []
	for (let length = segments.length; length >= 0; length--) directories.push(segments.slice(0, length).join('/'))
	return directories
}

const inDirectory = (directory: string, name: string): string => (directory === '' ? name : `${directory}/${name}`)

/** A path written in `configFile`, as `./<path from the root>`; `../<path>` when it climbs above the root. */
const fromRoot = (configFile: string, path: string): string => {
	const joined = joinRelative(configFile, path)
	return joined === undefined ? `../${path}` : `./${joined}`
}

const packageImports = (manifestFile: string, text: string): MappingTable => {
	const manifest = packageJsonSchema.safeParse(parseJsonc(text))
	const entries = new Map<string, readonly string[]>()
	for (const [pattern, value] of Object.entries(manifest.success ? (manifest.data.imports ?? {}) : {})) {
		entries.set(pattern, targetStrings(value).map((target) => (isRelativeSpecifier(target) ? fromRoot(manifestFile, target) : target)))
	}
	return entries
}

interface Declared<T> {
	readonly value: T
	/** The configuration file that declares it; relative paths in it are relative to that file. */
	readonly file: string
}

interface TsconfigOptions {
	readonly paths?: Declared<Readonly<Record<string, readonly string[]>>>
	readonly baseUrl?: Declared<string>
}

/** `paths` and `baseUrl` after `extends`: the extending file wins, and of an `extends` array the last entry. */
const tsconfigOptions = (file: string, files: ReadonlyMap<string, string>, seen: ReadonlySet<string>): TsconfigOptions => {
	const config = tsconfigSchema.safeParse(parseJsonc(files.get(file) ?? ''))
	if (!config.success) return {}
	let inherited: TsconfigOptions = {}
	const extended = config.data.extends
	for (const target of typeof extended === 'string' ? [extended] : (extended ?? [])) {
		// `checkTrustedResolution` refuses any other extends; the checker reads no file outside the application.
		const base = isRelativeSpecifier(target) ? joinRelative(file, target) : undefined
		const resolved = base === undefined ? undefined : [base, `${base}.json`].find((candidate) => files.has(candidate))
		if (resolved === undefined || seen.has(resolved)) continue
		const parent = tsconfigOptions(resolved, files, new Set([...seen, resolved]))
		inherited = { paths: parent.paths ?? inherited.paths, baseUrl: parent.baseUrl ?? inherited.baseUrl }
	}
	const options = config.data.compilerOptions
	return {
		paths: options?.paths === undefined ? inherited.paths : { value: options.paths, file },
		baseUrl: options?.baseUrl === undefined ? inherited.baseUrl : { value: options.baseUrl, file },
	}
}

/** `paths` targets are relative to `baseUrl` when one is set, and otherwise to the file that declares `paths`. */
const tsconfigPaths = (file: string, files: ReadonlyMap<string, string>): MappingTable => {
	const { paths, baseUrl } = tsconfigOptions(file, files, new Set([file]))
	if (paths === undefined) return EMPTY
	const baseDirectory = baseUrl === undefined ? undefined : joinRelative(baseUrl.file, baseUrl.value)
	const resolve = (target: string): string => {
		if (target.startsWith('/')) return target
		if (baseUrl === undefined) return fromRoot(paths.file, target)
		// A file in the baseUrl directory, which the target is relative to.
		return baseDirectory === undefined ? `../${target}` : fromRoot(inDirectory(baseDirectory, 'tsconfig.json'), target)
	}
	const entries = new Map<string, readonly string[]>()
	for (const [pattern, targets] of Object.entries(paths.value)) entries.set(pattern, targets.map(resolve))
	return entries
}

const memoized = <T>(compute: (key: string) => T): (key: string) => T => {
	const cache = new Map<string, T>()
	return (key) => {
		const cached = cache.get(key)
		if (cached !== undefined) return cached
		const value = compute(key)
		cache.set(key, value)
		return value
	}
}

export const readImportMappings = (files: ReadonlyMap<string, string>): ImportMappings => {
	const nearest = (file: string, names: readonly string[]): string | undefined => {
		for (const directory of directoriesAbove(file)) {
			const found = names.map((name) => inDirectory(directory, name)).find((path) => files.has(path))
			if (found !== undefined) return found
		}
		return undefined
	}
	const pathsOf = memoized((config: string) => tsconfigPaths(config, files))
	const importsOf = memoized((manifest: string) => packageImports(manifest, files.get(manifest) ?? ''))
	return {
		paths: (file) => {
			const config = nearest(file, TSCONFIG_NAMES)
			return config === undefined ? EMPTY : pathsOf(config)
		},
		imports: (file) => {
			const manifest = nearest(file, ['package.json'])
			return manifest === undefined ? EMPTY : importsOf(manifest)
		},
		mayExist: (target) => {
			const path = target.startsWith('/') ? undefined : joinRelative('package.json', target)
			if (path === undefined || isSkippedPath(path)) return true
			return resolveRelative((candidate) => files.has(candidate), 'package.json', `./${path}`).kind !== 'missing'
		},
	}
}

/**
 * The targets of the exact key, else of the most specific matching pattern: the longest prefix before its `*`, then the
 * longest key (Node's and Bun's order for `imports`: `#x/*.ts` before `#x/*`).
 */
const matchTable = (table: MappingTable, specifier: string): readonly string[] | undefined => {
	const exact = specifier.includes('*') ? undefined : table.get(specifier)
	if (exact !== undefined) return exact
	let best: { readonly prefix: number; readonly key: number; readonly targets: readonly string[] } | undefined
	for (const [pattern, targets] of table) {
		const star = pattern.indexOf('*')
		if (star === -1) continue
		const prefix = pattern.slice(0, star)
		const suffix = pattern.slice(star + 1)
		if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) continue
		if (best !== undefined && (best.prefix > prefix.length || (best.prefix === prefix.length && best.key >= pattern.length))) continue
		const captured = specifier.slice(prefix.length, specifier.length - suffix.length)
		best = { prefix: prefix.length, key: pattern.length, targets: targets.map((target) => target.replace('*', captured)) }
	}
	return best?.targets
}

/**
 * What a bare specifier in `file` is mapped to, in Bun's order: a builtin is never mapped; then the first `paths`
 * target that exists; when none does, the package scope's `imports`; `undefined` when nothing maps it, so it is loaded
 * as a package. A relative target is `./<path from the root>` (`../…` above it).
 */
export const mappedTargets = (mappings: ImportMappings, file: string, specifier: string): readonly string[] | undefined => {
	if (isBuiltin(specifier)) return undefined
	const path = matchTable(mappings.paths(file), specifier)?.find(mappings.mayExist)
	return path === undefined ? matchTable(mappings.imports(file), specifier) : [path]
}
