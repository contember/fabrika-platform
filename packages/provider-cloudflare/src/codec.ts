import type { ProviderCodec } from '@fabrika/provider-contract'
import { z } from 'zod'

/** Ephemeral credentials and handles used by one Cloudflare deploy. IAM's key is never among them (ADR-0022). */
export interface CloudflareTarget {
	readonly accountId: string
	readonly apiToken: string
	readonly stateNamespace?: string
}

/** A checkout recipe. The Oblaka graph stays executable code in the referenced config module. */
export interface CloudflareArtifact {
	readonly configPath: string
}

const targetSchema = z.object({ accountId: z.string().min(1), apiToken: z.string().min(1), stateNamespace: z.string().min(1).optional() })
const artifactSchema = z.object({ configPath: z.string().min(1) })

export const cloudflareTargetCodec: ProviderCodec<CloudflareTarget> = {
	version: 1,
	encode: (target) => ({
		accountId: target.accountId,
		apiToken: target.apiToken,
		...(target.stateNamespace === undefined ? {} : { stateNamespace: target.stateNamespace }),
	}),
	decode: (payload) => {
		const target = targetSchema.parse(payload)
		return {
			accountId: target.accountId,
			apiToken: target.apiToken,
			...(target.stateNamespace === undefined ? {} : { stateNamespace: target.stateNamespace }),
		}
	},
}

export const cloudflareArtifactCodec: ProviderCodec<CloudflareArtifact> = {
	version: 1,
	encode: (artifact) => ({ configPath: artifact.configPath }),
	decode: (payload) => artifactSchema.parse(payload),
}

/** Build the default checkout recipe used by the Cloudflare runner. */
export const cloudflareArtifact = (configPath = 'fabrika.config.ts'): CloudflareArtifact => ({ configPath })
