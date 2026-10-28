import type { ProviderCodec } from '@fabrika/provider-contract'
import { z } from 'zod'

/** A checkout recipe. The Oblaka graph stays executable code in the referenced config module. */
export interface CloudflareArtifact {
	readonly configPath: string
}

const artifactSchema = z.object({ configPath: z.string().min(1) })

export const cloudflareArtifactCodec: ProviderCodec<CloudflareArtifact> = {
	version: 1,
	encode: (artifact) => ({ configPath: artifact.configPath }),
	decode: (payload) => artifactSchema.parse(payload),
}

/** The config an environment deploys unless its artifact names another: the one Control reads the database from. */
export const DEFAULT_CONFIG_PATH = 'fabrika.config.ts'

/** Build the default checkout recipe used by the Cloudflare runner. */
export const cloudflareArtifact = (configPath = DEFAULT_CONFIG_PATH): CloudflareArtifact => ({ configPath })
