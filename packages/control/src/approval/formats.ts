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
import type { ContractArtifact as ContractArtifact06 } from '@fabrika/auth-core-0.6'
import type { ContractArtifact as ContractArtifact07 } from '@fabrika/auth-core-0.7'
import type { ContractArtifact as ContractArtifact08 } from '@fabrika/auth-core-0.8'

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
 * A 0.6 artifact is a 0.5 one: 0.6.0 released the framework sources of 0.5.5 unchanged, so its artifact, canonical form
 * and contract digest are 0.5's. It is kept, digested and upcast as the 0.5 format.
 */
export function from06(artifact: ContractArtifact06): SnapshotContract {
	return fromOlder(artifact)
}

/**
 * A 0.7 artifact is this release's format: 0.8 only added optional forms (the `altcha` challenge, its `challenge`
 * issuer rows, `csp.workerSrc`) that no 0.7 artifact holds, so its canonical form and contract digest are 0.7's. It is
 * kept as it is, read by this release's schema, which refuses one that is not.
 */
export function from07(artifact: ContractArtifact07): SnapshotContract {
	return { contract: parseContractArtifact(artifact) }
}

/**
 * A 0.8 artifact is this release's format: 0.9 only added an optional form (a cron job's `egress: 'public'`, ADR-0071)
 * that no 0.8 artifact holds, beside the dev launcher, which is not part of the contract, so its canonical form and
 * contract digest are 0.8's. It is kept as it is, read by this release's schema, which refuses one that is not.
 */
export function from08(artifact: ContractArtifact08): SnapshotContract {
	return { contract: parseContractArtifact(artifact) }
}

/**
 * The 0.5 artifact in this release's model. A release that changes the model adds its rule here, so that the approval
 * diff compares like with like and a 0.5 application's next deploy shows only what it changed itself.
 *
 * - 0.7: a job's `timeout` (`'30s'`, `'10m'`, `'1h'`, or `null`) is its effective `timeoutMs`, and a webhook carries
 *   its handler's `timeoutMs`; each is what a 0.5 release ran with.
 */
function upcast05(artifact: ContractArtifact05): ContractArtifact {
	const jobs = Object.fromEntries(
		Object.entries(artifact.jobs).map(([name, { timeout, ...job }]) => [name, { ...job, timeoutMs: release05JobTimeoutMs(timeout) }]),
	)
	const mounts = Object.fromEntries(
		Object.entries(artifact.mounts).map((
			[name, mount],
		) => [name, mount.kind === 'webhook' ? { ...mount, timeoutMs: RELEASE_05_WEBHOOK_TIMEOUT_MS } : mount]),
	)
	return { ...artifact, format: CONTRACT_FORMAT, jobs, mounts }
}

/** A 0.5 job without a `timeout` ran for 15 minutes; a 0.5 webhook handler, as every request, for 10 seconds. */
const RELEASE_05_JOB_TIMEOUT_MS = 15 * 60_000
const RELEASE_05_WEBHOOK_TIMEOUT_MS = 10_000
const RELEASE_05_DURATION = /^([1-9][0-9]*)([smh])$/
const RELEASE_05_UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000 }

/** A 0.5 job's `timeout` in ms. Its release's reader admitted only this form, so another value is a corrupt artifact. */
function release05JobTimeoutMs(timeout: string | null): number {
	if (timeout === null) return RELEASE_05_JOB_TIMEOUT_MS
	const match = RELEASE_05_DURATION.exec(timeout)
	const unit = match?.[2] === undefined ? undefined : RELEASE_05_UNIT_MS[match[2]]
	if (match?.[1] === undefined || unit === undefined) {
		throw new TypeError(`a 0.5 job's timeout '${timeout}' is not a duration its release admits`)
	}
	return Number.parseInt(match[1], 10) * unit
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
