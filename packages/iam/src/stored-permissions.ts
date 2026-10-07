import { parseJsonStringArray } from '@fabrika/auth-core'

/** Legacy rows retain valid patterns even when other entries are malformed. */
export function parseStoredPermissions(json: string): string[] {
	return parseJsonStringArray(json)
}
