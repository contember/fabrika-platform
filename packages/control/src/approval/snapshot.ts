// The access snapshot of a deploy run (ADR-0050): what Control read at the run's commit, and the one function every
// path that publishes access reads it through.

import { schemaFromContract } from '@fabrika/app/contract'
import { canonicalJson, type ContractArtifact, sha256Hex } from '@fabrika/auth-core'
import type { MigrationDeviation } from '@fabrika/platform-node/sql'
import { FRAMEWORK_RELEASE_PATTERN, type ProviderApprovedAccess } from '@fabrika/provider-contract'
import { z } from 'zod'
import type { AppEnvRow } from '../db'
import { applicationContractDigest, type OlderArtifact, parseStoredArtifact, readArtifactJson } from './formats'

/** One migration file of the commit, with the SHA-256 of its text (the checksum the application's ledger records). */
export interface MigrationEntry {
	readonly name: string
	readonly checksum: string
}

export interface AccessSnapshot {
	readonly version: 1
	/**
	 * The contract with its table policies, in this release's model; null only in the empty snapshot, since a commit
	 * without one is refused.
	 */
	readonly contract: ContractArtifact | null
	/**
	 * The artifact an older framework release's reader produced, when `contract` was upcast from it (ADR-0062). The
	 * snapshot stores and digests this one, and the application's contract digest is its release's digest of it.
	 */
	readonly older?: OlderArtifact
	readonly migrations: readonly MigrationEntry[]
	/**
	 * The database code the migration files declare (ADR-0017): each deviation by file, kind and object, in file order.
	 * Absent when there is none, so a snapshot without database code keeps the digest it had before the field existed.
	 */
	readonly databaseCode?: readonly MigrationDeviation[]
	/** The `@fabrika/check` release of the reader that read it; empty for the empty snapshot. */
	readonly checker: string
	/** The `@fabrika/app` release the application's `bun.lock` pins. Absent in a snapshot read before Control recorded it. */
	readonly framework?: string
}

/** The baseline of an environment that has published nothing: every item of a candidate is an addition. */
export const EMPTY_SNAPSHOT: AccessSnapshot = { version: 1, contract: null, migrations: [], checker: '' }

const deviationSchema = z.object({
	kind: z.enum(['function', 'procedure', 'trigger', 'view', 'materialized view', 'rule', 'policy', 'do', 'expression']),
	object: z.string().min(1),
	file: z.string().min(1),
	line: z.number().int().positive(),
}).strict() satisfies z.ZodType<MigrationDeviation>

const snapshotSchema = z.object({
	version: z.literal(1),
	contract: z.unknown(),
	migrations: z.array(z.object({ name: z.string().min(1), checksum: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
	databaseCode: z.array(deviationSchema).optional(),
	checker: z.string(),
	framework: z.string().regex(FRAMEWORK_RELEASE_PATTERN).optional(),
	// The gates and IAM schema of an application without a contract, in a snapshot stored before those were refused.
	artifact: z.unknown().optional(),
}).strict()

/**
 * Parse a stored snapshot; the contract is parsed by the schema of its own format and upcast, and a stored `artifact`
 * is dropped.
 */
export function parseSnapshot(raw: string): AccessSnapshot {
	const parsed = snapshotSchema.parse(JSON.parse(raw))
	return {
		version: parsed.version,
		...(parsed.contract === null ? { contract: null } : parseStoredArtifact(parsed.contract)),
		migrations: parsed.migrations,
		...(parsed.databaseCode === undefined || parsed.databaseCode.length === 0 ? {} : { databaseCode: parsed.databaseCode }),
		checker: parsed.checker,
		...(parsed.framework === undefined ? {} : { framework: parsed.framework }),
	}
}

/** The stored form: the artifact as the application's release read it, never the upcast. */
export function serializeSnapshot(snapshot: AccessSnapshot): string {
	const { older, contract, ...rest } = snapshot
	return JSON.stringify({ ...rest, contract: older ?? contract })
}

/**
 * The digest of the access a snapshot grants: the canonical contract, the migration list and the database code. The
 * checker version is not part of it, so reading the same commit with a newer checker approves nothing new. The
 * trailing `null` stood for artifact access; it stays, and the database code follows only when there is some, so that
 * the digests stored approvals name do not change.
 */
export function snapshotDigest(snapshot: AccessSnapshot): string {
	const migrations = [...snapshot.migrations].sort((a, b) => compareText(a.name, b.name))
	const contract = snapshot.contract === null ? 'null' : readArtifactJson(snapshot.contract, snapshot.older)
	const deviations = [...snapshot.databaseCode ?? []].sort((a, b) => compareText(deviationKey(a), deviationKey(b)))
	const databaseCode = deviations.length === 0 ? '' : `\n${canonicalJson(deviations)}`
	return `sha256:${sha256Hex(`${contract}\n${canonicalJson(migrations)}\nnull${databaseCode}`)}`
}

/** A deviation's identity across snapshots: its file, kind and object. Its line moves only with an edit of the file. */
export function deviationKey(deviation: MigrationDeviation): string {
	return `${deviation.file}\n${deviation.kind}\n${deviation.object}`
}

export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * What a provider publishes for a snapshot: the contract in this release's model and the IAM schema compiled from it,
 * the digest the application's own release computes, and the reader's release, which its build checks with.
 */
export function approvedAccess(snapshot: AccessSnapshot): ProviderApprovedAccess | undefined {
	const contract = snapshot.contract
	if (contract === null) return undefined
	return {
		contract,
		contractDigest: applicationContractDigest(contract, snapshot.older),
		schema: schemaFromContract(contract),
		checker: snapshot.checker,
	}
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
 *
 * A publication without a contract approves nothing and reads as the empty one: it was an application without a
 * contract, published before those were refused. Its next deploy is a contract compared with nothing.
 */
export function approvedSnapshot(appEnv: PublishedFields): ActiveSnapshot {
	const runId = appEnv.published_run_id
	const raw = appEnv.published_snapshot_json
	if ((runId === null) !== (raw === null)) throw new Error(`the publication of ${appEnv.app_id}/${appEnv.env} is incomplete`)
	const snapshot = raw === null ? null : parseSnapshot(raw)
	if (snapshot === null || snapshot.contract === null) return { runId: null, generation: appEnv.generation, snapshot: EMPTY_SNAPSHOT }
	return { runId, generation: appEnv.generation, snapshot }
}

/** What a provider may publish for an environment: its approved contract, or nothing. */
export interface ProviderAccessFields {
	readonly access?: ProviderApprovedAccess
}

/** `approvedSnapshot` as the provider reads it. */
export function approvedProviderAccess(appEnv: PublishedFields): ProviderAccessFields {
	const access = approvedAccess(approvedSnapshot(appEnv).snapshot)
	return access === undefined ? {} : { access }
}
