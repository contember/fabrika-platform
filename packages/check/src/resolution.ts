import { z } from 'zod/v4'

/** The application's own import mappings: `imports` in `package.json` (`#name`) and `compilerOptions.paths` in `tsconfig.json`. */
export interface ImportMappings {
	/** Pattern → targets, relative to the root. */
	readonly entries: ReadonlyMap<string, readonly string[]>
}

const packageJsonSchema = z.object({ imports: z.record(z.string(), z.unknown()).optional() })
const tsconfigSchema = z.object({
	compilerOptions: z.object({ baseUrl: z.string().optional(), paths: z.record(z.string(), z.array(z.string())).optional() }).optional(),
})

/** Every target string of an import-map value, through its condition objects and fallback arrays. */
const targetStrings = (value: unknown): string[] => {
	if (typeof value === 'string') return [value]
	if (Array.isArray(value)) return value.flatMap(targetStrings)
	if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(targetStrings)
	return []
}

const parseJsonc = (text: string | undefined): unknown => {
	if (text === undefined) return undefined
	try {
		return Bun.JSONC.parse(text)
	} catch {
		return undefined
	}
}

/** A `paths` target as a path from the root: `src/*` under `baseUrl: '.'` is `./src/*`. */
const pathTarget = (baseUrl: string, target: string): string => {
	if (target.startsWith('/')) return target
	const joined = baseUrl === '' || baseUrl === '.' || baseUrl === './' ? target : `${baseUrl.replace(/\/$/, '')}/${target}`
	return joined.startsWith('./') || joined.startsWith('../') ? joined : `./${joined}`
}

export const readImportMappings = (files: ReadonlyMap<string, string>): ImportMappings => {
	const entries = new Map<string, string[]>()
	const manifest = packageJsonSchema.safeParse(parseJsonc(files.get('package.json')))
	for (const [pattern, value] of Object.entries(manifest.success ? (manifest.data.imports ?? {}) : {})) entries.set(pattern, targetStrings(value))
	const tsconfig = tsconfigSchema.safeParse(parseJsonc(files.get('tsconfig.json')))
	const options = tsconfig.success ? tsconfig.data.compilerOptions : undefined
	for (const [pattern, targets] of Object.entries(options?.paths ?? {})) {
		entries.set(pattern, targets.map((target) => pathTarget(options?.baseUrl ?? '', target)))
	}
	return { entries }
}

/** The targets a bare specifier is mapped to, with `*` substituted; `undefined` when no pattern matches. */
export const mappedTargets = (mappings: ImportMappings, specifier: string): readonly string[] | undefined => {
	for (const [pattern, targets] of mappings.entries) {
		const star = pattern.indexOf('*')
		if (star === -1) {
			if (pattern === specifier) return targets
			continue
		}
		const prefix = pattern.slice(0, star)
		const suffix = pattern.slice(star + 1)
		if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) continue
		const captured = specifier.slice(prefix.length, specifier.length - suffix.length)
		return targets.map((target) => target.replace('*', captured))
	}
	return undefined
}
