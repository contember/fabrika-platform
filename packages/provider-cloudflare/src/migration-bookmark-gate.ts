// No imports: the release script loads this module to assert the gate (`release:validate`).

/**
 * The first framework release whose object records a migration bookmark before it migrates, migrates in one
 * transaction and answers a failed migration with a 422 `migration_failed` (ADR-0069 §3). `release:validate` refuses a
 * release at or above it whose framework source lacks that boot, and the gate naming a release tagged without it.
 */
export const MIGRATION_BOOKMARK_SINCE = '0.9.0-dev.49'
