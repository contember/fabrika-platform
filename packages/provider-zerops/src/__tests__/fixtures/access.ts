import { artifactAccessDigest } from '@fabrika/auth-core'
import type { ProviderArtifactApproval } from '@fabrika/provider-contract'
import { type FabrikaManifest, zeropsArtifactAccess } from '../../manifest'

/** What Control sends once it approved this artifact's own gates and IAM schema (ADR-0050). */
export const approvedArtifact = (manifest: FabrikaManifest, isProtected = false): ProviderArtifactApproval => ({
	digest: artifactAccessDigest(zeropsArtifactAccess(manifest)),
	protected: isProtected,
})
