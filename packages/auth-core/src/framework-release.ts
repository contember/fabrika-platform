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
