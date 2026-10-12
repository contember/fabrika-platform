// The application's schema name (ADR-0017), runtime-neutral: the runner derives it, and Control classifies a commit's
// migrations against the same name in a Worker.

import { PostgresMigrationError } from './postgres-migration-error'

/** IAM's application id alphabet; `-` maps to `_`, which the alphabet lacks, so two ids never share a schema. */
const APP_ID = /^[a-z0-9][a-z0-9-]*$/
/** Postgres truncates identifiers to 63 bytes; `app_` takes four of them. */
const MAX_APP_ID_LENGTH = 59

export function validateApplicationId(appId: string): void {
	if (!APP_ID.test(appId) || appId.length > MAX_APP_ID_LENGTH) {
		throw new PostgresMigrationError(`Invalid application id for a database schema: ${appId} (lowercase letters, digits and -, at most 59)`)
	}
}

/** `app_<id>`: the schema an application's migrations create and its data layer sets as its `search_path`. */
export function applicationDatabaseSchema(appId: string): string {
	validateApplicationId(appId)
	return `app_${appId.replaceAll('-', '_')}`
}
