// The IAM schema a Cloudflare config declares, read once before the checkout's `resources()` runs again. Worker-safe.

import { appSchemaSchema } from '@fabrika/auth'
import type { AppSchema } from '@fabrika/auth-core'

/**
 * A config's IAM schema, parsed and deep-frozen. A config that still declares `gates` is refused: an application is
 * protected by the endpoint table of its `fabrika.contract.ts`, and the platform's own services by theirs.
 */
export const configSchema = (config: { readonly gates?: unknown; readonly schema?: unknown }): AppSchema | null => {
	if (config.gates !== undefined) {
		throw new Error('cloudflare: the config declares `gates`, which no deployment reads any more; protect the application with `fabrika.contract.ts`')
	}
	if (config.schema === undefined) return null
	const parsed = appSchemaSchema.safeParse(config.schema)
	if (!parsed.success) throw new Error("cloudflare: the config's IAM `schema` is malformed")
	return deepFreeze(parsed.data)
}

function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const child of Object.values(value)) deepFreeze(child)
	}
	return value
}
