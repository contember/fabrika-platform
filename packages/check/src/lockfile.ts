// An application's `bun.lock`: the checker refuses an entry of a trusted package that does not come from the npm
// registry, and Control reads from it the framework release the application pins (ADR-0062). Worker-safe.

import { parseJsonc } from './jsonc'

export const LOCKFILE = 'bun.lock'

/** An exact version, as `bun install` records one resolved from the registry. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** One `packages` entry: `[<name>@<version>, <registry>, <metadata>, <integrity>]`; a tarball has no registry. */
export interface LockfileEntry {
	/** What follows `<name>@` in the resolution, or empty when the resolution names another package. */
	readonly version: string
	readonly registry: unknown
	readonly integrity: unknown
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `packages` of a `bun.lock` by key; null when the text is not a lockfile bun writes. */
export function lockfilePackages(text: string): Readonly<Record<string, unknown>> | null {
	const lockfile = parseJsonc(text)
	const packages = isRecord(lockfile) ? lockfile['packages'] : undefined
	return isRecord(packages) ? packages : null
}

export function lockfileEntry(name: string, entry: unknown): LockfileEntry {
	const resolution = Array.isArray(entry) ? entry[0] : undefined
	return {
		version: typeof resolution === 'string' && resolution.startsWith(`${name}@`) ? resolution.slice(name.length + 1) : '',
		registry: Array.isArray(entry) ? entry[1] : undefined,
		integrity: Array.isArray(entry) ? entry.at(-1) : undefined,
	}
}

/**
 * The registry version the lockfile resolves the package `name` to for the application itself: its top-level entry,
 * not one nested under another package. Null when the text is not a lockfile, holds no such entry, or resolves it from
 * anywhere but the npm registry.
 */
export function lockedRegistryVersion(text: string, name: string): string | null {
	const packages = lockfilePackages(text)
	if (packages === null) return null
	const entry = lockfileEntry(name, packages[name])
	return entry.registry === '' && EXACT_VERSION.test(entry.version) ? entry.version : null
}
