// The contract artifact formats of this platform's window (ADR-0062). Control keeps an artifact as the reader of the
// application's own release produced it: that is what a snapshot stores and digests, and its contract digest is the one
// the application computes at startup. Everything that interprets access (the approval diff, the proxy table, the IAM
// schema) reads the artifact upcast to this release's model instead.

import { parseContractArtifact as parseContractArtifact05 } from '@fabrika/app-0.5/contract'
import { parseContractArtifact } from '@fabrika/app/contract'
import { canonicalArtifactJson, CONTRACT_FORMAT, type ContractArtifact, contractDigest } from '@fabrika/auth-core'
import type { ContractArtifact as ContractArtifact04 } from '@fabrika/auth-core-0.4'
import {
	canonicalArtifactJson as canonicalArtifactJson05,
	type ContractArtifact as ContractArtifact05,
	contractDigest as contractDigest05,
} from '@fabrika/auth-core-0.5'

/** An artifact of a format older than this release's, as its own release's reader produced it. */
export type OlderArtifact = ContractArtifact05

/** A snapshot's contract: this release's model, and the older artifact it was upcast from, when it was. */
export interface SnapshotContract {
	readonly contract: ContractArtifact
	readonly older?: OlderArtifact
}

/** The 0.5 artifact carries no `format`. */
const isFormat05 = (value: unknown): boolean => typeof value === 'object' && value !== null && !('format' in value)

/** Parse a stored artifact of any format in the window by its own schema, and upcast it. */
export function parseStoredArtifact(value: unknown): SnapshotContract {
	if (isFormat05(value)) return fromOlder(parseContractArtifact05(value))
	return { contract: parseContractArtifact(value) }
}

export function fromOlder(older: OlderArtifact): SnapshotContract {
	return { contract: upcast05(older), older }
}

/**
 * A 0.4 artifact is a 0.5 one: 0.5 added only optional fields, and its canonical form and contract digest are 0.4's
 * for an artifact without them. So it is kept, digested and upcast as the 0.5 format.
 */
export function from04(artifact: ContractArtifact04): SnapshotContract {
	return fromOlder(artifact)
}

/**
 * The 0.5 artifact in this release's model. A release that changes the model adds its rule here, so that the approval
 * diff compares like with like and a 0.5 application's next deploy shows only what it changed itself.
 */
function upcast05(artifact: ContractArtifact05): ContractArtifact {
	return { ...artifact, format: CONTRACT_FORMAT }
}

/**
 * The canonical JSON of the artifact the application's release read, by that release's rules: `older` when the model
 * was upcast from it. A snapshot's digest is taken over it, so it survives a platform upgrade.
 */
export function readArtifactJson(contract: ContractArtifact, older: OlderArtifact | undefined): string {
	return older === undefined ? canonicalArtifactJson(contract) : canonicalArtifactJson05(older)
}

/** The digest the application's own release computes for its contract, which it compares with `FABRIKA_CONTRACT_DIGEST`. */
export function applicationContractDigest(contract: ContractArtifact, older: OlderArtifact | undefined): string {
	return older === undefined ? contractDigest(contract) : contractDigest05(older)
}
