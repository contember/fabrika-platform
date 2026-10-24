// The one rule about a sidecar's pin: it names a published TAG of `contember/fabrika-platform`, never a
// branch. A namespace proxy and an installation both build from tags, so a moving ref would make "which
// version is this installation running" unanswerable (ADR-0025).

/**
 * A published release tag: `v` and a semantic version.
 *
 * The same shape `scripts/release.ts` accepts, restated rather than imported — that script is not a
 * package and this check has to hold in a published tarball.
 */
const TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** The pinned ref, or an error naming what was found. A branch is refused, deliberately and loudly. */
export const assertPinnedTag = (ref: string): string => {
	const trimmed = ref.trim()
	if (trimmed === '') {
		throw new Error('a published fabrika tag is required, for example v0.1.0')
	}
	if (!TAG_PATTERN.test(trimmed)) {
		throw new Error(
			`\`${trimmed}\` is not a published tag. A sidecar repository pins a TAG such as v0.1.0 and never a branch: `
				+ 'an installation that tracked a moving ref could not say which version it runs (ADR-0025)',
		)
	}
	return trimmed
}
