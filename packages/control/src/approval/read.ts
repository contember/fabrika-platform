// Reading a run's access snapshot at its pinned commit (ADR-0050 §1): the contract graph and `src/db/tables.ts` through
// the static reader, which executes nothing (ADR-0005), the migration list with checksums, and the database code the
// migrations declare, through the classifier the runner applies them with (ADR-0017).

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
import { applicationDatabaseSchema, classifyMigrations, type MigrationDeviation, type MigrationSetClassification } from '@fabrika/platform-node/sql'
import type { CommitFiles } from '../github/source/commit-files'
import type { AccessSnapshot, MigrationEntry } from './snapshot'

/** What one snapshot read may cost: files, rounds of import discovery, and bytes per file. */
export const SNAPSHOT_LIMITS = {
	readerFiles: 256,
	readerRounds: 32,
	readerFileBytes: CONTRACT_LIMITS.sourceBytes,
	migrations: 1000,
	migrationBytes: 1024 * 1024,
	/** The classifier reads the whole set at once, so its text is held in memory together. */
	migrationsTotalChars: 16 * 1024 * 1024,
} as const

const MIGRATION_READS_AT_ONCE = 8

/** What the contract reader may ask for: modules, the JSON configurations beside them, `bunfig.toml`. */
const READER_INPUT = /\.(?:[cm]?[jt]s|[jt]sx|json|toml)$/

/**
 * The repository paths a snapshot of the application at `root` may read: the reader's inputs and the migrations. A source
 * that reads the whole commit at once keeps these; `readAccessSnapshot` still asks for exactly what it needs.
 */
export function snapshotReads(root: string): (path: string) => boolean {
	const prefix = root === '' ? '' : `${root}/`
	return (path) => {
		if (!path.startsWith(prefix)) return false
		const relative = path.slice(prefix.length)
		return relative.startsWith(MIGRATIONS_DIR) || READER_INPUT.test(relative)
	}
}

/** Why a commit cannot be read as an access snapshot. A fixed code, never text from the checkout. */
export type SnapshotRefusalCode =
	| 'root-invalid'
	| 'contract-too-large'
	| 'contract-invalid'
	| 'contract-unreadable'
	| 'contract-app-mismatch'
	| 'migrations-too-many'
	| 'migrations-too-large'
	| 'migrations-refused'
	| 'migrations-unreadable'

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

/** The commit has no `fabrika.contract.ts`. Fabrika deploys an application only with a contract (ADR-0050). */
export class ContractMissing extends Error {
	override readonly name = 'ContractMissing'

	constructor() {
		super(`the commit has no \`${CONTRACT_FILE}\`; Fabrika deploys an application only with a contract`)
	}
}

/**
 * The snapshot of the application at `root` (repository-relative, `''` for the root) in `commit`. A commit without
 * `fabrika.contract.ts` is refused (`ContractMissing`), whatever its configuration says. `settled` are the migrations
 * the environment's published snapshot holds: as the runner skips an applied file, a refused statement in one of them,
 * unchanged, does not refuse the read.
 */
export async function readAccessSnapshot(
	commit: CommitFiles,
	root: string,
	appId: string,
	settled: readonly MigrationEntry[] = [],
): Promise<AccessSnapshot> {
	const inRepository = (path: string): string => (root === '' ? path : `${root}/${path}`)
	const exists = (path: string): boolean => commit.paths.has(inRepository(path))
	if (!exists(CONTRACT_FILE)) throw new ContractMissing()
	const migrations = await readMigrations(commit, root)
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
	const databaseCode = readDatabaseCode(migrations, appId, settled)
	return {
		version: 1,
		contract,
		migrations: migrations.map(({ name, checksum }) => ({ name, checksum })),
		...(databaseCode.length === 0 ? {} : { databaseCode }),
		checker: CHECKER_VERSION,
	}
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

/**
 * The deviations of every migration file, classified as one set against the application's schema, as the runner
 * classifies them before it applies one. A refused statement in a file not yet settled fails the read: the runner
 * would refuse the file.
 */
function readDatabaseCode(migrations: readonly ReadMigration[], appId: string, settled: readonly MigrationEntry[]): MigrationDeviation[] {
	if (migrations.length === 0) return []
	let classified: MigrationSetClassification
	try {
		classified = classifyMigrations(migrations, applicationDatabaseSchema(appId))
	} catch {
		// An unexpected classifier error may quote the checkout; only the code leaves this function.
		throw new SnapshotRefused('migrations-unreadable')
	}
	const settledChecksums = new Map(settled.map((entry) => [entry.name, entry.checksum]))
	const pending = new Set(migrations.filter((migration) => settledChecksums.get(migration.name) !== migration.checksum).map(({ name }) => name))
	const refused = classified.files.filter((file) => pending.has(file.file)).reduce((count, file) => count + file.refused.length, 0)
	if (refused > 0) throw new SnapshotRefused('migrations-refused', refused)
	return classified.files.flatMap((file) => file.deviations)
}

interface ReadMigration extends MigrationEntry {
	readonly sql: string
}

/** Every file under the migrations directory, with its text and the SHA-256 of it. */
async function readMigrations(commit: CommitFiles, root: string): Promise<ReadMigration[]> {
	const directory = root === '' ? MIGRATIONS_DIR : `${root}/${MIGRATIONS_DIR}`
	const paths = [...commit.paths].filter((path) => path.startsWith(directory)).sort()
	if (paths.length > SNAPSHOT_LIMITS.migrations) {
		throw new SnapshotRefused('migrations-too-many')
	}
	const migrations: ReadMigration[] = []
	let total = 0
	for (let start = 0; start < paths.length; start += MIGRATION_READS_AT_ONCE) {
		const batch = paths.slice(start, start + MIGRATION_READS_AT_ONCE)
		migrations.push(
			...await Promise.all(batch.map(async (path) => {
				const sql = await commit.read(path, SNAPSHOT_LIMITS.migrationBytes)
				return { name: path.slice(directory.length), checksum: sha256Hex(sql), sql }
			})),
		)
		total += migrations.slice(start).reduce((sum, migration) => sum + migration.sql.length, 0)
		if (total > SNAPSHOT_LIMITS.migrationsTotalChars) throw new SnapshotRefused('migrations-too-large')
	}
	return migrations
}
