// The artifact access of an application without a contract (ADR-0050): the config's gates and IAM schema. The executor
// and the control plane parse it with the same schemas, so the digest one computes is the digest the other compares.
// Worker-safe: `./runner` re-exports this module.

import { appSchemaSchema } from '@fabrika/auth'
import type { ArtifactAccess } from '@fabrika/auth-core'
import { proxyAppGatesSchema } from '@fabrika/proxy-core/manifest'
import { z } from 'zod'

export const artifactAccessSchema = z.object({ gates: proxyAppGatesSchema.nullable(), schema: appSchemaSchema.nullable() })
	.strict() satisfies z.ZodType<
		ArtifactAccess,
		z.ZodTypeDef,
		unknown
	>

/** A config's gates and IAM schema, parsed as a report of them is parsed. */
export const configArtifactAccess = (config: { readonly gates?: unknown; readonly schema?: unknown }): ArtifactAccess => {
	const parsed = artifactAccessSchema.safeParse({ gates: config.gates ?? null, schema: config.schema ?? null })
	if (!parsed.success) throw new Error("cloudflare: the config's `gates` or IAM `schema` are malformed")
	return parsed.data
}
