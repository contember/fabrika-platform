import { z } from 'zod'
import { parseJsonOrNull } from './json'

const storedPermissionsSchema = z.array(z.unknown()).transform((values) => values.filter((value): value is string => typeof value === 'string'))

/** Legacy rows retain valid patterns even when other entries are malformed. */
export function parseStoredPermissions(json: string): string[] {
	const parsed = storedPermissionsSchema.safeParse(parseJsonOrNull(json))
	return parsed.success ? parsed.data : []
}
