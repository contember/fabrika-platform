// Whether the Bun of a contract application's build base reads its `bun.lock`. The platform build installs with
// `bun install --frozen-lockfile` on the base the selected setup names in `build.base` (ADR-0043), and a Bun older than
// the one that wrote the lockfile fails that install late, in a started build container, with `Unknown lockfile
// version`. `fabrika app build`, `app register` and the builder's deploy refuse such a base before anything deploys,
// from the lockfile they compile beside; a commit after registration is not checked. PURE: no filesystem.

import type { JsonValue } from '@fabrika/provider-contract'
import { parseZeropsDescriptor, selectZeropsDescriptorSetup } from './descriptor'
import { lockedAuthoredBuild, ZEROPS_APPLICATION_RUNTIME } from './execution'
import type { FabrikaManifest } from './manifest'

interface BunRelease {
	readonly major: number
	readonly minor: number
}

/**
 * The oldest Bun that reads each `lockfileVersion` of a text `bun.lock` (measured: 1.1.45 reads 0 and refuses 1, 1.2
 * and 1.3 read 1 and refuse 2, 1.4 writes 2 for a new lockfile). A version missing here is newer than every Bun this
 * list knows. Add a row when a Bun release writes a new version.
 */
const LOCKFILE_READERS: ReadonlyMap<number, BunRelease> = new Map([
	[0, { major: 1, minor: 1 }],
	[1, { major: 1, minor: 2 }],
	[2, { major: 1, minor: 4 }],
])

/** The oldest Bun base Zerops offers (`alpine/bun@1.3`, `ubuntu/bun@1.3`): a refusal never names an older one. */
const OLDEST_OFFERED_BUN: BunRelease = { major: 1, minor: 3 }

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
	const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
	const match = /^\s*\{\s*"lockfileVersion"\s*:\s*(\d+)\s*[,}]/.exec(unmarked)
	return match?.[1] === undefined ? null : Number(match[1])
}

/** The build base of the manifest's selected setup, and whether the application named it or the platform's default applies. */
export interface ZeropsBuildBase {
	readonly setup: string
	/** Each base the build image is made of; empty for an application without a contract, whose build is its own. */
	readonly bases: readonly string[]
	readonly authored: boolean
}

const isSetup = (value: JsonValue, setup: string): value is { readonly [key: string]: JsonValue } =>
	typeof value === 'object' && value !== null && !Array.isArray(value) && value['setup'] === setup

/**
 * The bases the platform build of a contract application runs on, read as `renderLockedSetup` reads them: the selected
 * setup's `build.base`, or the platform's runtime when it names none. The platform does not generate the build of an
 * application without a contract, so it has none here.
 */
export function zeropsBuildBase(manifest: FabrikaManifest): ZeropsBuildBase {
	const parsed = parseZeropsDescriptor(manifest.target.sourceDescriptor.contents)
	const setup = selectZeropsDescriptorSetup(parsed, manifest.target.zeropsSetup)
	const entries = parsed.document['zerops']
	const entry = Array.isArray(entries) ? entries.find((candidate) => isSetup(candidate, setup)) : undefined
	if (manifest.target.contract === undefined || entry === undefined) return { setup, bases: [], authored: false }
	const base = lockedAuthoredBuild(entry, setup).base
	if (base === null) return { setup, bases: [ZEROPS_APPLICATION_RUNTIME], authored: false }
	return { setup, bases: typeof base === 'string' ? [base] : base, authored: true }
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
			const remedy = `${match[1] ?? ''}bun@${named(atLeast(reader, OLDEST_OFFERED_BUN) ? reader : OLDEST_OFFERED_BUN)}`
			return `bun.lock has lockfileVersion ${version}, which Bun ${
				named(bun)
			} cannot read, and ${install}; set build.base: ${remedy}, or regenerate bun.lock with Bun ${named(bun)}, which resolves every dependency afresh`
		}
	}
	return null
}

/** Why the manifest's build cannot install from a `bun.lock` of this text, or null; what every compile runs. */
export const lockfileBuildBaseRefusal = (manifest: FabrikaManifest, lockfile: string): string | null =>
	buildBaseLockfileRefusal(lockfile, zeropsBuildBase(manifest))
