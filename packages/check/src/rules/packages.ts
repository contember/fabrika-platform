// The routine ways to replace a package the platform trusts by name (ADR-0043): a manifest override or patch, a
// specifier that does not name a registry version, a lockfile entry without the registry's integrity hash, another
// registry, and an ambient module declaration that retypes it. The platform build installs from the lockfile with
// `--frozen-lockfile`, so a trusted entry that resolves from the registry with its hash is the package itself.

import { type AstNode, child, staticString } from '../ast'
import type { Finding, Report } from '../finding'
import { parseJsonc } from '../jsonc'
import { BUNFIG_FILE, isTrustedSpecifier } from '../trust'

export const LOCKFILE = 'bun.lock'
export const NPMRC_FILE = '.npmrc'

const REPLACEMENT_FIELDS = ['patchedDependencies', 'overrides', 'resolutions'] as const
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
/** An exact version or a caret/tilde range of one: what `bun add` writes for a registry package. */
const REGISTRY_RANGE = /^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const REGISTRY_ALLOWED = 'a registry version of the package, such as "^1.2.3", resolved by bun install from the npm registry'

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Where `needle` first appears in `text`, as a finding position; the start of the file when it does not. */
const positionIn = (text: string, needle: string): { readonly line: number; readonly column: number } => {
	const index = text.indexOf(needle)
	if (index === -1) return { line: 1, column: 1 }
	const before = text.slice(0, index)
	return { line: before.split('\n').length, column: index - (before.lastIndexOf('\n') + 1) + 1 }
}

/** The package a lockfile key names: `@fabrika/app` for both `@fabrika/app` and `some-dep/@fabrika/app`. */
const lockfilePackage = (key: string): string => {
	const segments = key.split('/')
	const last = segments.at(-1) ?? ''
	const scope = segments.at(-2)
	return scope?.startsWith('@') === true ? `${scope}/${last}` : last
}

export const checkPackageReplacement = (files: ReadonlyMap<string, string>): Finding[] => {
	const findings: Finding[] = []
	const finding = (file: string, needle: string, message: string, allowed: string): void => {
		findings.push({ file, ...positionIn(files.get(file) ?? '', needle), rule: 'package-replacement', message, allowed })
	}
	for (const [path, text] of files) {
		if (baseName(path) === 'package.json') checkManifest(path, text, finding)
		else if (path === LOCKFILE) checkLockfile(text, finding)
		else if (path === BUNFIG_FILE) checkRegistryConfiguration(path, text, finding)
		else if (path === NPMRC_FILE) checkNpmrc(text, finding)
	}
	return findings
}

type Finder = (file: string, needle: string, message: string, allowed: string) => void

function checkManifest(path: string, text: string, finding: Finder): void {
	const manifest = parseJsonc(text)
	if (!isRecord(manifest)) return
	for (const field of REPLACEMENT_FIELDS) {
		if (manifest[field] !== undefined) {
			finding(path, `"${field}"`, `${field} can replace any package, the ones the platform trusts by name included`, `no ${field} in package.json`)
		}
	}
	for (const field of DEPENDENCY_FIELDS) {
		const dependencies = manifest[field]
		if (!isRecord(dependencies)) continue
		for (const [name, specifier] of Object.entries(dependencies)) {
			if (!isTrustedSpecifier(name)) continue
			if (typeof specifier !== 'string' || !REGISTRY_RANGE.test(specifier)) {
				finding(path, `"${name}"`, `${field} names ${name} as '${String(specifier)}', which is not a registry version`, REGISTRY_ALLOWED)
			}
		}
	}
}

function checkLockfile(text: string, finding: Finder): void {
	const lockfile = parseJsonc(text)
	const packages = isRecord(lockfile) ? lockfile['packages'] : undefined
	if (!isRecord(packages)) {
		finding(LOCKFILE, '', `${LOCKFILE} has no packages the check can read`, 'a bun.lock written by bun install')
		return
	}
	for (const [key, entry] of Object.entries(packages)) {
		const name = lockfilePackage(key)
		if (!isTrustedSpecifier(name)) continue
		const resolution = Array.isArray(entry) ? entry[0] : undefined
		const registry = Array.isArray(entry) ? entry[1] : undefined
		const integrity = Array.isArray(entry) ? entry.at(-1) : undefined
		const version = typeof resolution === 'string' && resolution.startsWith(`${name}@`) ? resolution.slice(name.length + 1) : ''
		if (!EXACT_VERSION.test(version) || registry !== '' || typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
			finding(
				LOCKFILE,
				`"${key}"`,
				`the lockfile entry of ${name} does not resolve from the npm registry with an integrity hash`,
				'a registry version in package.json and a bun.lock written by bun install',
			)
		}
	}
}

/** Another registry serves its own build of a trusted package under the same name and version. */
function checkRegistryConfiguration(path: string, text: string, finding: Finder): void {
	let section: string | null = null
	for (const line of text.split('\n')) {
		const header = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line)
		if (header !== null) {
			section = header[1] ?? null
			if (section?.startsWith('install.scopes') === true) {
				finding(path, line.trim(), 'a scoped registry can serve a package the platform trusts by name', 'the default npm registry')
			}
		} else if (section === 'install' && /^\s*(?:registry|scopes)\s*=/.test(line)) {
			finding(path, line.trim(), 'another registry can serve a package the platform trusts by name', 'the default npm registry')
		}
	}
}

function checkNpmrc(text: string, finding: Finder): void {
	for (const line of text.split('\n')) {
		if (/registry\s*=/.test(line)) {
			finding(NPMRC_FILE, line.trim(), 'another registry can serve a package the platform trusts by name', 'the default npm registry')
		}
	}
}

/** `declare module '@fabrika/app'` retypes a trusted package for the type check without changing what runs. */
export const checkAmbientModule = (node: AstNode, report: Report): void => {
	if (node.type !== 'TSModuleDeclaration') return
	const name = staticString(child(node, 'id'))
	if (name !== undefined && isTrustedSpecifier(name)) {
		report(node, 'package-replacement', `declare module '${name}' retypes a package the platform trusts by name`, 'no module declaration for it')
	}
}
