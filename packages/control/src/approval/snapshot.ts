// The access snapshot of a deploy run (ADR-0050): what Control read at the run's commit, and the one function every
// path that publishes access reads it through.

import { parseContractArtifact, schemaFromContract } from '@fabrika/app/contract'
import { appSchemaSchema } from '@fabrika/auth'
import {
	type ArtifactAccess,
	artifactAccessDigest,
	canonicalArtifactJson,
	canonicalJson,
	type ContractArtifact,
	contractDigest,
	sha256Hex,
} from '@fabrika/auth-core'
import type { ProviderApprovedAccess, ProviderArtifactApproval } from '@fabrika/provider-contract'
import { proxyAppGatesSchema } from '@fabrika/proxy-core/manifest'
import { z } from 'zod'
import type { AppEnvRow } from '../db'

/** One migration file of the commit, with the SHA-256 of its text (the checksum the application's ledger records). */
export interface MigrationEntry {
	readonly name: string
	readonly checksum: string
}

export interface AccessSnapshot {
	readonly version: 1
	/** The contract with its table policies; null when the commit has no `fabrika.contract.ts`. */
	readonly contract: ContractArtifact | null
	readonly migrations: readonly MigrationEntry[]
	/** The `@fabrika/check` version that read it; empty for the empty snapshot. */
	readonly checker: string
	/**
	 * Without a contract, the artifact's gates and IAM schema: from the provider before the deploy, or as the deploy
	 * reported them. Null with a contract, and before any is known.
	 */
	readonly artifact: ArtifactAccess | null
}

/** The baseline of an environment that has published nothing: every item of a candidate is an addition. */
export const EMPTY_SNAPSHOT: AccessSnapshot = { version: 1, contract: null, migrations: [], checker: '', artifact: null }

/** Gates and an IAM schema read back as JSON (a stored snapshot, a runner's report), parsed by their own schemas. */
export const artifactAccessSchema = z.object({
	gates: proxyAppGatesSchema.nullable(),
	schema: appSchemaSchema.nullable(),
}).strict() satisfies z.ZodType<ArtifactAccess, z.ZodTypeDef, unknown>

const snapshotSchema = z.object({
	version: z.literal(1),
	contract: z.unknown(),
	migrations: z.array(z.object({ name: z.string().min(1), checksum: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
	checker: z.string(),
	artifact: artifactAccessSchema.nullable(),
}).strict()

/** Parse a stored snapshot; the contract is parsed by the artifact's own schema. */
export function parseSnapshot(raw: string): AccessSnapshot {
	const parsed = snapshotSchema.parse(JSON.parse(raw))
	return {
		version: parsed.version,
		contract: parsed.contract === null ? null : parseContractArtifact(parsed.contract),
		migrations: parsed.migrations,
		checker: parsed.checker,
		artifact: parsed.artifact,
	}
}

export function serializeSnapshot(snapshot: AccessSnapshot): string {
	return JSON.stringify(snapshot)
}

/**
 * The digest of the access a snapshot grants: the canonical contract, the migration list and the artifact access. The
 * checker version is not part of it, so reading the same commit with a newer checker approves nothing new.
 */
export function snapshotDigest(snapshot: AccessSnapshot): string {
	const migrations = [...snapshot.migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	const contract = snapshot.contract === null ? 'null' : canonicalArtifactJson(snapshot.contract)
	const artifact = snapshot.artifact === null ? 'null' : artifactAccessDigest(snapshot.artifact)
	return `sha256:${sha256Hex(`${contract}\n${canonicalJson(migrations)}\n${artifact}`)}`
}

/** What a provider publishes for a snapshot: the contract, its digest and the IAM schema compiled from it. */
export function approvedAccess(snapshot: AccessSnapshot): ProviderApprovedAccess | undefined {
	const contract = snapshot.contract
	return contract === null ? undefined : { contract, contractDigest: contractDigest(contract), schema: schemaFromContract(contract) }
}

/** The environment's active snapshot and the publication it came from. */
export interface ActiveSnapshot {
	/** The published run; null when nothing is published and the snapshot is the empty one. */
	readonly runId: string | null
	/** The compare-and-swap token a publication names. */
	readonly generation: number
	readonly snapshot: AccessSnapshot
}

type PublishedFields = Pick<AppEnvRow, 'app_id' | 'env' | 'published_run_id' | 'published_snapshot_json' | 'generation'>

/**
 * The environment's approved snapshot: the one its last publication wrote, or the empty one. Every path that publishes
 * a proxy table or reconciles IAM reads access through this function, never from the provider artifact (ADR-0050).
 */
export function approvedSnapshot(appEnv: PublishedFields): ActiveSnapshot {
	const runId = appEnv.published_run_id
	const raw = appEnv.published_snapshot_json
	if ((runId === null) !== (raw === null)) throw new Error(`the publication of ${appEnv.app_id}/${appEnv.env} is incomplete`)
	return { runId, generation: appEnv.generation, snapshot: raw === null ? EMPTY_SNAPSHOT : parseSnapshot(raw) }
}

/** What a provider may publish for an environment: its approved contract, or the artifact access approved without one. */
export interface ProviderAccessFields {
	readonly access?: ProviderApprovedAccess
	readonly artifactAccess?: ProviderArtifactApproval
}

/**
 * `approvedSnapshot` as the provider reads it. Without a contract, the approved artifact access by its digest: a
 * provider applies an artifact's gates and schema only when they hash to it. Nothing before a first publication.
 */
export function approvedProviderAccess(appEnv: PublishedFields & Pick<AppEnvRow, 'protected'>): ProviderAccessFields {
	const active = approvedSnapshot(appEnv)
	if (active.runId === null) return {}
	const access = approvedAccess(active.snapshot)
	if (access !== undefined) return { access }
	const artifact = active.snapshot.artifact
	return { artifactAccess: { digest: artifact === null ? null : artifactAccessDigest(artifact), protected: appEnv.protected === 1 } }
}
