// Reading a run's access snapshot at its pinned commit (ADR-0050 §1): the contract graph and `src/db/tables.ts` through
// the static reader, which executes nothing (ADR-0005), and the migration list with checksums.

import { sha256Hex } from '@fabrika/auth-core'
import {
	CHECKER_VERSION,
	CONTRACT_FILE,
	CONTRACT_LIMITS,
	ContractError,
	contractReaderInputs,
	ContractSourceError,
	MIGRATIONS_DIR,
	readContractSource,
} from '@fabrika/check/contract'
import type { CommitFiles } from '../github/source/commit-files'
import type { AccessSnapshot, MigrationEntry } from './snapshot'

/** What one snapshot read may cost: files, rounds of import discovery, and bytes per file. */
export const SNAPSHOT_LIMITS = {
	readerFiles: 256,
	readerRounds: 32,
	readerFileBytes: CONTRACT_LIMITS.sourceBytes,
	migrations: 1000,
	migrationBytes: 1024 * 1024,
} as const

const MIGRATION_READS_AT_ONCE = 8

/** Why a commit cannot be read as an access snapshot. A fixed code, never text from the checkout. */
export type SnapshotRefusalCode =
	| 'root-invalid'
	| 'contract-too-large'
	| 'contract-invalid'
	| 'contract-unreadable'
	| 'contract-app-mismatch'
	| 'migrations-too-many'

/**
 * The commit cannot be read as an access snapshot. The run log gets only the code and the number of problems: the
 * snapshot is logged before the run's secrets are known, and checkout text can carry one (`fabrika-check` names them).
 */
export class SnapshotRefused extends Error {
	override readonly name = 'SnapshotRefused'

	constructor(readonly code: SnapshotRefusalCode, readonly problems = 1) {
		super(`snapshot refused (${code}, ${problems} problem${problems === 1 ? '' : 's'})`)
	}
}

/**
 * The snapshot of the application at `root` (repository-relative, `''` for the root) in `commit`. A commit without
 * `fabrika.contract.ts` has no contract: the application is not a contract application, whatever its configuration
 * says.
 */
export async function readAccessSnapshot(commit: CommitFiles, root: string, appId: string): Promise<AccessSnapshot> {
	const inRepository = (path: string): string => (root === '' ? path : `${root}/${path}`)
	const exists = (path: string): boolean => commit.paths.has(inRepository(path))
	const migrations = await readMigrations(commit, root)
	if (!exists(CONTRACT_FILE)) return { version: 1, contract: null, migrations, checker: CHECKER_VERSION }
	const files = new Map<string, string>()
	for (let round = 0;; round++) {
		const missing = contractReaderInputs(files, exists)
		if (missing.length === 0) break
		if (round >= SNAPSHOT_LIMITS.readerRounds || files.size + missing.length > SNAPSHOT_LIMITS.readerFiles) {
			throw new SnapshotRefused('contract-too-large')
		}
		for (const path of missing) files.set(path, await commit.read(inRepository(path), SNAPSHOT_LIMITS.readerFileBytes))
	}
	const contract = readContract(files)
	if (contract.app !== appId) {
		throw new SnapshotRefused('contract-app-mismatch')
	}
	return { version: 1, contract, migrations, checker: CHECKER_VERSION }
}

function readContract(files: ReadonlyMap<string, string>) {
	try {
		return readContractSource(files)
	} catch (error) {
		if (error instanceof ContractSourceError) throw new SnapshotRefused('contract-invalid', error.findings.length)
		if (error instanceof ContractError) throw new SnapshotRefused('contract-invalid', error.problems.length)
		// An unexpected reader error may quote the checkout; only the code leaves this function.
		throw new SnapshotRefused('contract-unreadable')
	}
}

/** Every file under the migrations directory, with the SHA-256 of its text. */
async function readMigrations(commit: CommitFiles, root: string): Promise<MigrationEntry[]> {
	const directory = root === '' ? MIGRATIONS_DIR : `${root}/${MIGRATIONS_DIR}`
	const paths = [...commit.paths].filter((path) => path.startsWith(directory)).sort()
	if (paths.length > SNAPSHOT_LIMITS.migrations) {
		throw new SnapshotRefused('migrations-too-many')
	}
	const migrations: MigrationEntry[] = []
	for (let start = 0; start < paths.length; start += MIGRATION_READS_AT_ONCE) {
		const batch = paths.slice(start, start + MIGRATION_READS_AT_ONCE)
		migrations.push(
			...await Promise.all(batch.map(async (path) => ({
				name: path.slice(directory.length),
				checksum: sha256Hex(await commit.read(path, SNAPSHOT_LIMITS.migrationBytes)),
			}))),
		)
	}
	return migrations
}
