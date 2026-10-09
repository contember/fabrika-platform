import { contractDigest } from '@fabrika/auth-core'
import type { ProviderApprovedAccess } from '@fabrika/provider-contract'
import { schemaFromContract } from '../../../../app/src/contract/platform'
import { notesArtifact } from '../../../../auth-core/src/__tests__/fixtures/notes-artifact'

/** What Control sends once it approved the contract of the commit it read (ADR-0050). */
export const approvedContract = (contract = notesArtifact): ProviderApprovedAccess => ({
	contract,
	contractDigest: contractDigest(contract),
	schema: schemaFromContract(contract),
})
