// The platform reads `z`, `defineContract` and `defineTables` by the package they are imported from. That holds only
// while nothing in the application redirects those packages, so every configuration that can redirect an import is
// checked here, for the checker and for the reader alike. Plain JavaScript: the reader runs it in a Worker.

import type { Finding } from './finding'
import { parseJsonc } from './jsonc'
import { isIgnoredSegment, isRelativeSpecifier, isSourceFile, isToolModule, joinRelative } from './layout'
import { isKey, parseToml } from './toml'

/** Packages whose exports the reader trusts by name, and the packages they rely on. */
export const isTrustedSpecifier = (specifier: string): boolean =>
	specifier === 'zod' || specifier.startsWith('zod/') || specifier === 'bun' || specifier.startsWith('@fabrika/')

/** Representatives of every trusted specifier form: a pattern that can match one of these is refused. */
const TRUSTED_FORMS: readonly { readonly prefix: string; readonly open: boolean }[] = [
	{ prefix: 'zod', open: false },
	{ prefix: 'zod/', open: true },
	{ prefix: 'bun', open: false },
	{ prefix: '@fabrika/', open: true },
]

/** Whether an import-map pattern (`zod/*`, `*`, `@fab*`, `zod`) can match a trusted specifier. */
export const patternMayMatchTrusted = (pattern: string): boolean => {
	const star = pattern.indexOf('*')
	if (star === -1) {
		return isTrustedSpecifier(pattern)
	}
	const prefix = pattern.slice(0, star)
	const suffix = pattern.slice(star + 1)
	return TRUSTED_FORMS.some((form) => {
		if (form.open) {
			// An open form continues with any text, so the pattern matches once its literal prefix agrees with it.
			return form.prefix.startsWith(prefix) || prefix.startsWith(form.prefix)
		}
		return form.prefix.startsWith(prefix) && form.prefix.slice(prefix.length).endsWith(suffix)
	})
}

const TSCONFIG_NAMES = ['tsconfig.json', 'jsconfig.json']
export const BUNFIG_FILE = 'bunfig.toml'

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The configuration files `checkTrustedResolution` reads, wherever they lie: Bun reads the nearest one. */
export const isResolutionConfig = (path: string): boolean =>
	TSCONFIG_NAMES.includes(baseName(path)) || baseName(path) === 'package.json' || path === BUNFIG_FILE

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Where `needle` first appears in `text`, as a finding position; the start of the file when it does not. */
const positionIn = (text: string, needle: string): { readonly line: number; readonly column: number } => {
	const index = text.indexOf(needle)
	if (index === -1) {
		return { line: 1, column: 1 }
	}
	const before = text.slice(0, index)
	const lineStart = before.lastIndexOf('\n') + 1
	return { line: before.split('\n').length, column: index - lineStart + 1 }
}

/**
 * Every configuration among `files` that could make a trusted import load something else: a `paths` or `imports`
 * pattern that can match it, a `baseUrl` (an application file shadows a package under it), an `extends` the check
 * cannot follow, an unparseable `tsconfig.json`, and a runtime `preload` in `bunfig.toml` (a plugin can redirect any
 * import).
 */
export const checkTrustedResolution = (files: ReadonlyMap<string, string>): Finding[] => {
	const findings: Finding[] = []
	const finding = (file: string, needle: string, message: string, allowed: string): void => {
		findings.push({ file, ...positionIn(files.get(file) ?? '', needle), severity: 'refusal', rule: 'unchecked-import', message, allowed })
	}
	for (const [path, text] of files) {
		if (TSCONFIG_NAMES.includes(baseName(path))) {
			checkTsconfig(path, text, files, finding, new Set([path]))
		} else if (baseName(path) === 'package.json') {
			const manifest = parseJsonc(text)
			const imports = isRecord(manifest) ? manifest['imports'] : undefined
			for (const pattern of isRecord(imports) ? Object.keys(imports) : []) {
				if (patternMayMatchTrusted(pattern)) {
					finding(path, `"${pattern}"`, `the import map entry '${pattern}' can redirect a package the platform trusts by name`, MAP_ALLOWED)
				}
			}
		} else if (path === BUNFIG_FILE) {
			checkBunfig(text, (needle, message, allowed) => finding(path, needle, message, allowed))
		}
	}
	return findings
}

const MAP_ALLOWED = 'mappings only for specifiers other than @fabrika/*, zod, zod/* and bun'

type Report = (file: string, needle: string, message: string, allowed: string) => void

function checkTsconfig(path: string, text: string, files: ReadonlyMap<string, string>, report: Report, seen: ReadonlySet<string>): void {
	const config = parseJsonc(text)
	if (!isRecord(config)) {
		report(path, '', `${path} is not JSON with comments, so its import mappings cannot be checked`, 'a tsconfig.json that parses')
		return
	}
	const options = config['compilerOptions']
	if (isRecord(options)) {
		if (options['baseUrl'] !== undefined) {
			report(
				path,
				'"baseUrl"',
				'baseUrl lets an application file shadow a package the platform trusts by name',
				'paths with relative targets, without baseUrl',
			)
		}
		const paths = options['paths']
		for (const pattern of isRecord(paths) ? Object.keys(paths) : []) {
			if (patternMayMatchTrusted(pattern)) {
				report(path, `"${pattern}"`, `the paths entry '${pattern}' can redirect a package the platform trusts by name`, MAP_ALLOWED)
			}
		}
	}
	const extended = config['extends']
	const targets = typeof extended === 'string' ? [extended] : Array.isArray(extended) ? extended : []
	for (const target of targets) {
		if (typeof target !== 'string' || !isRelativeSpecifier(target)) {
			report(
				path,
				'"extends"',
				`${path} extends '${String(target)}', a configuration outside what the platform reads`,
				'a relative extends of a file inside the application, or none',
			)
			continue
		}
		const base = joinRelative(path, target)
		const resolved = base === undefined ? undefined : [base, `${base}.json`].find((candidate) => files.has(candidate))
		if (resolved === undefined) {
			report(
				path,
				'"extends"',
				`${path} extends '${target}', which is not a file inside the application`,
				'a relative extends of a file inside the application, or none',
			)
		} else if (!seen.has(resolved)) {
			checkTsconfig(resolved, files.get(resolved) ?? '', files, report, new Set([...seen, resolved]))
		}
	}
}

/**
 * A test preload must be a checked application file: a skipped or generated one runs unchecked during the build, and a
 * developer's tool is not checked as application code.
 */
const isCheckedTestPreload = (target: string): boolean => {
	if (!target.startsWith('./')) return false
	const segments = target.slice(2).split('/')
	return segments[0] !== 'fabrika' && !isToolModule(target.slice(2))
		&& segments.every((segment) => segment !== '' && segment !== '..' && !isIgnoredSegment(segment))
		&& isSourceFile(target)
}

/**
 * Bun's runtime `preload` runs before the application and can register a plugin that resolves any import; read with
 * Bun's own key decoding, so `"preload"` is `preload`. A test preload runs during the platform build.
 */
function checkBunfig(text: string, report: (needle: string, message: string, allowed: string) => void): void {
	const lines = text.split('\n')
	const at = (line: number): string => lines[line - 1]?.trim() ?? ''
	const document = parseToml(text)
	if (!document.ok) {
		report(
			at(document.line),
			`bunfig.toml line ${document.line} is outside the TOML the platform reads (${document.message})`,
			'single-line keys and values: strings, numbers, booleans and arrays of them',
		)
		return
	}
	for (const entry of document.entries) {
		if (isKey(entry, 'preload')) {
			report(
				at(entry.line),
				'a runtime preload can register a plugin that redirects any import, trusted packages included',
				'no top-level preload in bunfig.toml',
			)
		}
		if (isKey(entry, 'test', 'preload')) {
			const targets = entry.value.kind === 'array' ? entry.value.items : [entry.value]
			for (const target of targets) {
				if (target.kind !== 'string' || !isCheckedTestPreload(target.value)) {
					report(
						at(entry.line),
						'a test preload outside the checked application files runs unchecked in the platform build',
						"'./<path>' of a source file the checker reads, outside fabrika/, tools/, dist/, node_modules/ and dot directories",
					)
				}
			}
		}
	}
}
