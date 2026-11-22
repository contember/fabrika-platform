// The publish floors: the first framework release whose source enforces a field an artifact may state (ADR-0062,
// ADR-0073 §5). A floor is the release after the source version when its enforcement lands, since the source version
// names the last release cut. `enforcement-floors.test.ts` holds that, and `scripts/release.ts` refuses a tag below a
// floor of its own source and a hotfix whose tag reaches a floor its base is below. Type imports only: the release
// script loads this module.

import type { Release } from './readers'

/**
 * The first framework release whose data layer and dispatch enforce relations, `via`, `confers` and `when`. Compared
 * with its prerelease: every earlier `0.9.0-*` release reads none of them and would widen access.
 */
export const RELATION_GRANTS_SINCE: Release = { text: '0.9.0-dev.13', major: 0, minor: 9, patch: 0 }

/**
 * The first framework release that ANDs a table's `relationWhen` onto its relation's terms, and reads a table's access
 * views (ADR-0076). An earlier one ignores `relationWhen` and refuses `access` at build and boot.
 */
export const RELATION_WHEN_SINCE: Release = { text: '0.9.0-dev.14', major: 0, minor: 9, patch: 0 }

/** Every publish floor, in ascending order. */
export const PUBLISH_FLOORS: readonly Release[] = [RELATION_GRANTS_SINCE, RELATION_WHEN_SINCE]
