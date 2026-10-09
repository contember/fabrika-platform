import { canonicalJson } from './contract-canonical'
import { sha256Hex } from './sha256'
import type { AppGates, AppSchema } from './types'

/**
 * The access of an application without a contract (ADR-0050): the gates its proxy enforces and the IAM schema it
 * reconciles. On a protected environment Control approves it like a contract: by its digest, against the last one
 * a human or an unprotected deploy approved.
 */
export interface ArtifactAccess {
	readonly gates: AppGates | null
	readonly schema: AppSchema | null
}

/** The digest an approval of artifact access names. Gate order is precedence, so it is kept. */
export function artifactAccessDigest(access: ArtifactAccess): string {
	return `sha256:${sha256Hex(canonicalJson({ gates: access.gates, schema: access.schema }))}`
}
