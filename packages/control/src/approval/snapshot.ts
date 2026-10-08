// The access snapshot of a deploy run (ADR-0050): what Control read at the run's commit, and the one function every
// path that publishes access reads it through.

import { parseContractArtifact, schemaFromContract } from '@fabrika/app/contract'
import { canonicalArtifactJson, canonicalJson, type ContractArtifact, contractDigest, sha256Hex } from '@fabrika/auth-core'
import type { ProviderApprovedAccess } from '@fabrika/provider-contract'
import { z } from 'zod'
import type { AppEnvRow, ControlRepositories } from '../db'

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
}

/** The baseline of an environment that has published nothing: every item of a candidate is an addition. */
export const EMPTY_SNAPSHOT: AccessSnapshot = { version: 1, contract: null, migrations: [], checker: '' }

const snapshotSchema = z.object({
	version: z.literal(1),
	contract: z.unknown(),
	migrations: z.array(z.object({ name: z.string().min(1), checksum: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
	checker: z.string(),
}).strict()

/** Parse a stored snapshot; the contract is parsed by the artifact's own schema. */
export function parseSnapshot(raw: string): AccessSnapshot {
	const parsed = snapshotSchema.parse(JSON.parse(raw))
	return {
		version: parsed.version,
		contract: parsed.contract === null ? null : parseContractArtifact(parsed.contract),
		migrations: parsed.migrations,
		checker: parsed.checker,
	}
}

export function serializeSnapshot(snapshot: AccessSnapshot): string {
	return JSON.stringify(snapshot)
}

/**
 * The digest of the access a snapshot grants: the canonical contract and the migration list. The checker version is
 * not part of it, so reading the same commit with a newer checker approves nothing new.
 */
export function snapshotDigest(snapshot: AccessSnapshot): string {
	const migrations = [...snapshot.migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	const contract = snapshot.contract === null ? 'null' : canonicalArtifactJson(snapshot.contract)
	return `sha256:${sha256Hex(`${contract}\n${canonicalJson(migrations)}`)}`
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

/**
 * The environment's approved snapshot: the snapshot of its published run, or the empty one. Every path that publishes a
 * proxy table or reconciles IAM reads access through this function, never from the provider artifact (ADR-0050).
 */
export async function approvedSnapshot(
	repositories: Pick<ControlRepositories, 'runs'>,
	appEnv: Pick<AppEnvRow, 'app_id' | 'env' | 'published_run_id' | 'generation'>,
): Promise<ActiveSnapshot> {
	const runId = appEnv.published_run_id
	if (runId === null) return { runId: null, generation: appEnv.generation, snapshot: EMPTY_SNAPSHOT }
	const run = await repositories.runs.getRun(runId)
	if (run === null || run.app_id !== appEnv.app_id || run.env !== appEnv.env || run.snapshot_json === null) {
		throw new Error(`the published run of ${appEnv.app_id}/${appEnv.env} has no snapshot`)
	}
	return { runId, generation: appEnv.generation, snapshot: parseSnapshot(run.snapshot_json) }
}

/** `approvedSnapshot` as the provider reads it. */
export async function approvedProviderAccess(
	repositories: Pick<ControlRepositories, 'runs'>,
	appEnv: Pick<AppEnvRow, 'app_id' | 'env' | 'published_run_id' | 'generation'>,
): Promise<ProviderApprovedAccess | undefined> {
	return approvedAccess((await approvedSnapshot(repositories, appEnv)).snapshot)
}
