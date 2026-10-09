// The artifact access of an application without a contract (ADR-0050): the config's gates and IAM schema. The executor
// and the control plane parse it with the same schemas, so the digest one computes is the digest the other compares.
// Worker-safe: `./runner` re-exports this module.

import { appSchemaSchema } from '@fabrika/auth'
import { type ArtifactAccess, canonicalArtifactAccess, DuplicateAccessIdentifierError } from '@fabrika/auth-core'
import { proxyAppGatesSchema } from '@fabrika/proxy-core/manifest'
import { z } from 'zod'

export const artifactAccessSchema = z.object({ gates: proxyAppGatesSchema.nullable(), schema: appSchemaSchema.nullable() })
	.strict() satisfies z.ZodType<
		ArtifactAccess,
		z.ZodTypeDef,
		unknown
	>

/**
 * A config's gates and IAM schema, parsed as a report of them is parsed, canonical and deep-frozen. The deployer reads
 * them once, before the checkout's `resources()` runs, and builds the proxy, the report and IAM from this one value.
 */
export const configArtifactAccess = (config: { readonly gates?: unknown; readonly schema?: unknown }): ArtifactAccess => {
	const parsed = artifactAccessSchema.safeParse({ gates: config.gates ?? null, schema: config.schema ?? null })
	if (!parsed.success) throw new Error("cloudflare: the config's `gates` or IAM `schema` are malformed")
	try {
		return deepFreeze(canonicalArtifactAccess(parsed.data))
	} catch (error) {
		if (error instanceof DuplicateAccessIdentifierError) throw new Error(`cloudflare: the config's ${error.list} name one identifier twice`)
		throw error
	}
}

function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const child of Object.values(value)) deepFreeze(child)
	}
	return value
}
