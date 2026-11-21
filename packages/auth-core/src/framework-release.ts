/** A framework release as npm publishes it; the only form one may take before it reaches a generated build command. */
export const FRAMEWORK_RELEASE_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * Whether framework release `release` is at least `since`. A prerelease counts as its `major.minor`; a release that
 * does not start with `<major>.<minor>.` is never at least anything (ADR-0062).
 */
export const releaseAtLeast = (release: string, since: { readonly major: number; readonly minor: number }): boolean => {
	const match = /^(\d+)\.(\d+)\./.exec(release)
	if (match === null) return false
	const major = Number(match[1])
	return major > since.major || (major === since.major && Number(match[2]) >= since.minor)
}

/** A release as semver orders it: the numeric core, then the prerelease identifiers (none sorts above any). */
interface ReleaseVersion {
	readonly core: readonly number[]
	readonly prerelease: readonly string[]
}

const parseReleaseVersion = (release: string): ReleaseVersion | null => {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(release)
	if (match === null) return null
	return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

/** Semver's order of two prerelease identifiers: numerically when both are numeric, a numeric one first, else by ASCII. */
const compareIdentifiers = (a: string, b: string): number => {
	const numericA = /^\d+$/.test(a)
	const numericB = /^\d+$/.test(b)
	if (numericA && numericB) return Number(a) - Number(b)
	if (numericA !== numericB) return numericA ? -1 : 1
	return a < b ? -1 : a > b ? 1 : 0
}

const compareReleases = (a: ReleaseVersion, b: ReleaseVersion): number => {
	for (const [index, part] of a.core.entries()) {
		const other = b.core[index] ?? 0
		if (part !== other) return part - other
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
	for (const [index, identifier] of a.prerelease.entries()) {
		const other = b.prerelease[index]
		if (other === undefined) return 1
		const order = compareIdentifiers(identifier, other)
		if (order !== 0) return order
	}
	return a.prerelease.length - b.prerelease.length
}

/**
 * Whether framework release `release` is at or above the exact version `since` in semver's precedence, prerelease
 * included; a release that is not a semver version never is (ADR-0062).
 */
export const releaseFrom = (release: string, since: string): boolean => {
	const floor = parseReleaseVersion(since)
	if (floor === null) throw new Error(`releaseFrom: \`${since}\` is not a semver version`)
	const version = parseReleaseVersion(release)
	return version !== null && compareReleases(version, floor) >= 0
}

/**
 * The release a gate reads for an approved access: the application's pin, never the reader's `checker`, which is this
 * platform's patch of the pin's minor and so passes a `releaseFrom` gate a prerelease pin does not. An access approved before Control recorded the pin is read as the oldest release of its
 * reader's minor (`<major>.<minor>.0-0`): every `releaseAtLeast` gate answers as for that minor, and every `releaseFrom`
 * gate of a prerelease or a patch fails closed, as for an older application, until a deploy reads its pin.
 */
export const applicationRelease = (access: { readonly checker: string; readonly framework?: string }): string => {
	if (access.framework !== undefined) return access.framework
	const minor = /^(\d+)\.(\d+)\./.exec(access.checker)
	return minor === null ? access.checker : `${minor[1]}.${minor[2]}.0-0`
}
