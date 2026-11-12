// Whether the Bun of an application's build base reads its `bun.lock`. The platform build installs with
// `bun install --frozen-lockfile` on the base the selected setup names in `build.base` (ADR-0043), and a Bun older than
// the one that wrote the lockfile fails that install late, in a started build container, with `Unknown lockfile
// version`. `fabrika app build` and `app register` refuse such a base before anything deploys. PURE: no filesystem.

import type { JsonValue } from '@fabrika/provider-contract'
import { appliedZeropsSetups, parseZeropsDescriptor, selectZeropsDescriptorSetup } from './descriptor'
import { ZEROPS_APPLICATION_RUNTIME } from './execution'
import type { FabrikaManifest } from './manifest'

interface BunRelease {
	readonly major: number
	readonly minor: number
}

/**
 * The oldest Bun that reads each `lockfileVersion` of a text `bun.lock`. A version missing here is newer than every
 * Bun this list knows. Add a row when a Bun release writes a new version.
 */
const LOCKFILE_READERS: ReadonlyMap<number, BunRelease> = new Map([
	[0, { major: 1, minor: 2 }],
	[1, { major: 1, minor: 2 }],
	[2, { major: 1, minor: 4 }],
])

/** The newest Bun the table knows: it writes the newest `lockfileVersion` there, and reads no newer one. */
const NEWEST_KNOWN_BUN: BunRelease = { major: 1, minor: 4 }
const NEWEST_KNOWN_LOCKFILE = Math.max(...LOCKFILE_READERS.keys())

/** A Bun base with a numeric version: `bun@1.3`, `alpine/bun@1.3`, `ubuntu/bun@1.3.9`. An alias such as `@latest` is not. */
const BUN_BASE = /^((?:alpine|ubuntu)\/)?bun@(\d+)\.(\d+)(?:\.\d+)?$/

const atLeast = (release: BunRelease, floor: BunRelease): boolean =>
	release.major > floor.major || (release.major === floor.major && release.minor >= floor.minor)

const named = (release: BunRelease): string => `${release.major}.${release.minor}`

/**
 * The `lockfileVersion` of a `bun.lock`, or null when the text does not start with one. Bun writes it as the first
 * key; the rest of the file is JSONC (trailing commas), which this never parses.
 */
export function bunLockfileVersion(text: string): number | null {
	const match = /^﻿?\s*\{\s*"lockfileVersion"\s*:\s*(\d+)\s*[,}]/.exec(text)
	return match?.[1] === undefined ? null : Number(match[1])
}

/** The build base of the manifest's selected setup, and whether the application named it or the platform's default applies. */
export interface ZeropsBuildBase {
	readonly setup: string
	/** Each base the build image is made of; empty when the setup names none and the platform adds none. */
	readonly bases: readonly string[]
	readonly authored: boolean
}

const isMapping = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The bases the manifest's selected setup builds on. Zerops merges `extends` per whole section, so the `build` of the
 * first applied setup that has one is the build. A contract application without `build.base` builds on the platform's
 * runtime (`renderLockedSetup`).
 */
export function zeropsBuildBase(manifest: FabrikaManifest): ZeropsBuildBase {
	const parsed = parseZeropsDescriptor(manifest.target.sourceDescriptor.contents)
	const setup = selectZeropsDescriptorSetup(parsed, manifest.target.zeropsSetup)
	const build = appliedZeropsSetups(parsed, setup).map((entry) => isMapping(entry) ? entry['build'] : undefined).find(isMapping)
	const base = build?.['base']
	if (typeof base === 'string') return { setup, bases: [base], authored: true }
	if (Array.isArray(base)) return { setup, bases: base.filter((entry) => typeof entry === 'string'), authored: true }
	return { setup, bases: manifest.target.contract === undefined ? [] : [ZEROPS_APPLICATION_RUNTIME], authored: false }
}

/**
 * Why the build cannot install from a `bun.lock` of this text, or null when it can or when that cannot be known: a
 * lockfile without a readable version, or a base that is not a Bun release with a numeric version (an alias such as
 * `alpine/bun@latest`, or another runtime).
 */
export function buildBaseLockfileRefusal(lockfile: string, build: ZeropsBuildBase): string | null {
	const version = bunLockfileVersion(lockfile)
	if (version === null) return null
	const reader = LOCKFILE_READERS.get(version)
	for (const base of build.bases) {
		const match = BUN_BASE.exec(base)
		if (match === null) continue
		const bun = { major: Number(match[2]), minor: Number(match[3]) }
		const where = build.authored
			? `build.base \`${base}\` of zerops.yaml setup \`${build.setup}\``
			: `\`${base}\`, the base of zerops.yaml setup \`${build.setup}\`, which names no build.base`
		const install = `the platform build runs \`bun install --frozen-lockfile\` on ${where}`
		if (reader === undefined) {
			// A Bun newer than every known one may read it; only a known one is refused.
			if (atLeast(NEWEST_KNOWN_BUN, bun)) {
				const known = `Bun ${named(NEWEST_KNOWN_BUN)} reads up to lockfileVersion ${NEWEST_KNOWN_LOCKFILE}`
				return `bun.lock has lockfileVersion ${version}, newer than any Bun base this release knows (${known}), and ${install}; set build.base to the Bun release that wrote bun.lock (\`bun --version\`)`
			}
			continue
		}
		if (!atLeast(bun, reader)) {
			return `bun.lock has lockfileVersion ${version}, which Bun ${named(bun)} cannot read, and ${install}; set build.base: ${match[1] ?? ''}bun@${
				named(reader)
			} (Bun ${named(reader)} or later reads it), or write bun.lock with Bun ${named(bun)}`
		}
	}
	return null
}
