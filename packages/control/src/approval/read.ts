// Reading a run's access snapshot at its pinned commit (ADR-0050 §1): the contract graph and `src/db/tables.ts` through
// the static reader of the framework release the application pins (ADR-0062), which executes nothing (ADR-0005), the
// migration list with checksums, and the database code the migrations declare, through the classifier the runner
// applies them with (ADR-0017). A migration the environment applied and the commit changed is refused here, before the
// build, by the checksum rule the runners refuse it with.

import { sha256Hex } from '@fabrika/auth-core'
import { CONTRACT_FILE, CONTRACT_LIMITS, lockedRegistryVersion, LOCKFILE, MIGRATIONS_DIR } from '@fabrika/check/contract'
import {
	applicationDatabaseSchema,
	classifyMigrations,
	type FileAdoption,
	type MigrationDataLoss,
	type MigrationDeviation,
	type MigrationDialect,
	type MigrationSetClassification,
} from '@fabrika/platform-node/sql'
import type { CommitFiles } from '../github/source/commit-files'
import type { SnapshotContract } from './formats'
import { type ContractReader, FRAMEWORK_PACKAGE, FrameworkReleaseRefused, readerFor, type ReaderOutcome } from './readers'
import { type AccessSnapshot, isBundledMigration, type MigrationEntry, storedSnapshotFits } from './snapshot'

/** What one snapshot read may cost: files, rounds of import discovery, bytes per file and in all. */
export const SNAPSHOT_LIMITS = {
	/**
	 * Memory and parse work are bounded by `readerTotalChars` and `readerRounds`, not by this count; each file costs one
	 * read of the commit (a GitHub request on Cloudflare). A large application's contract needs 283.
	 */
	readerFiles: 512,
	readerRounds: 32,
	/** One module's limit, which every reader of the window holds: an older reader parses what it is given before it counts. */
	readerFileBytes: CONTRACT_LIMITS.moduleBytes,
	/**
	 * The reader's inputs held in memory together: its modules, which the reader bounds by `sourceBytes` only once it
	 * parses them, and their configuration files. A round may name many modules at once.
	 */
	readerTotalChars: 2 * CONTRACT_LIMITS.sourceBytes,
	lockfileBytes: 8 * 1024 * 1024,
	migrations: 1000,
	migrationBytes: 1024 * 1024,
	/** The classifier reads the whole set at once, so its text is held in memory together. */
	migrationsTotalChars: 16 * 1024 * 1024,
} as const

const MIGRATION_READS_AT_ONCE = 8

/** What the contract reader may ask for: modules, the JSON configurations beside them, `bunfig.toml`. */
const READER_INPUT = /\.(?:[cm]?[jt]s|[jt]sx|json|toml)$/

/**
 * The repository paths a snapshot of the application at `root` may read: the lockfile, the reader's inputs and the
 * migrations. A source that reads the whole commit at once keeps these; `readAccessSnapshot` still asks for exactly
 * what it needs.
 */
export function snapshotReads(root: string): (path: string) => boolean {
	const prefix = root === '' ? '' : `${root}/`
	return (path) => {
		if (!path.startsWith(prefix)) return false
		const relative = path.slice(prefix.length)
		return relative === LOCKFILE || relative.startsWith(MIGRATIONS_DIR) || READER_INPUT.test(relative)
	}
}

/** Lockfiles of other package managers and bun's binary one: Control reads only the text `bun.lock`. */
const OTHER_LOCKFILES: Readonly<Record<string, string>> = {
	'bun.lockb': `it has bun.lockb, which Control does not read; run \`bun install --save-text-lockfile\` and commit ${LOCKFILE}`,
	'package-lock.json': `it has package-lock.json; an application installs with bun, so commit the ${LOCKFILE} that \`bun install\` writes`,
	'yarn.lock': `it has yarn.lock; an application installs with bun, so commit the ${LOCKFILE} that \`bun install\` writes`,
	'pnpm-lock.yaml': `it has pnpm-lock.yaml; an application installs with bun, so commit the ${LOCKFILE} that \`bun install\` writes`,
}

/**
 * The `@fabrika/app` release the application's `bun.lock` resolves, at its root: the framework release whose reader
 * reads the contract. Throws `FrameworkReleaseRefused` with one line when there is no such lockfile or entry.
 */
async function readFrameworkRelease(commit: CommitFiles, inRepository: (path: string) => string): Promise<string> {
	if (!commit.paths.has(inRepository(LOCKFILE))) {
		const other = Object.keys(OTHER_LOCKFILES).find((name) => commit.paths.has(inRepository(name)))
		const reason = other === undefined ? `commit the ${LOCKFILE} that \`bun install\` writes` : OTHER_LOCKFILES[other]
		throw new FrameworkReleaseRefused(`the application root has no ${LOCKFILE}, which names its ${FRAMEWORK_PACKAGE} release; ${reason}`)
	}
	const release = lockedRegistryVersion(await commit.read(inRepository(LOCKFILE), SNAPSHOT_LIMITS.lockfileBytes), FRAMEWORK_PACKAGE)
	if (release === null) throw new FrameworkReleaseRefused(`${LOCKFILE} resolves no npm registry release of ${FRAMEWORK_PACKAGE}`)
	return release
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

const APPLIED_MIGRATION_ALLOWED = 'as applied and put the change in a new migration (`bunx fabrika db new <slug>`)'

/**
 * Migrations the environment applied whose text changed since: every runner refuses the deploy (ADR-0017), but only
 * after the build. `lines` holds one line per file, under the application root.
 */
export class AppliedMigrationsChanged extends Error {
	override readonly name = 'AppliedMigrationsChanged'
	readonly lines: readonly string[]

	constructor(readonly files: readonly string[]) {
		const one = files.length === 1
		super(
			`${one ? 'an applied migration' : `${files.length} applied migrations`} changed: ${files.join(', ')}; leave ${
				one ? 'it' : 'each'
			} ${APPLIED_MIGRATION_ALLOWED}`,
		)
		this.lines = files.map((file) => `${file}: an applied migration changed; leave it ${APPLIED_MIGRATION_ALLOWED}`)
	}
}

/** What `readAccessSnapshot` knows of the environment's migrations, and the dialect it classifies them in. */
export interface SnapshotReadOptions {
	/**
	 * The migrations the environment's published snapshot holds: as the runner skips an applied file, a refused statement
	 * in one of them, unchanged, does not refuse the read.
	 */
	readonly settled?: readonly MigrationEntry[]
	/** The migrations the environment's database applied, each as it ran: a file among them whose text changed is refused. */
	readonly applied?: readonly MigrationEntry[]
	/** The database the provider runs the application's migrations on. */
	readonly dialect?: MigrationDialect
}

/**
 * The snapshot of the application at `root` (repository-relative, `''` for the root) in `commit`. A commit without
 * `fabrika.contract.ts` is refused (`ContractMissing`), whatever its configuration says, and one that changed an
 * `applied` migration (`AppliedMigrationsChanged`).
 */
export async function readAccessSnapshot(
	commit: CommitFiles,
	root: string,
	appId: string,
	{ settled = [], applied = [], dialect = 'postgres' }: SnapshotReadOptions = {},
): Promise<AccessSnapshot> {
	const inRepository = (path: string): string => (root === '' ? path : `${root}/${path}`)
	const exists = (path: string): boolean => commit.paths.has(inRepository(path))
	if (!exists(CONTRACT_FILE)) throw new ContractMissing()
	const framework = await readFrameworkRelease(commit, inRepository)
	const reader = readerFor(framework)
	const migrations = await readMigrations(commit, root)
	const changed = changedAppliedMigrations(applied, migrations)
	if (changed.length > 0) throw new AppliedMigrationsChanged(changed.map((name) => `${MIGRATIONS_DIR}${name}`))
	const files = new Map<string, string>()
	let chars = 0
	for (let round = 0;; round++) {
		const missing = reader.inputs(files, exists)
		if (missing.length === 0) break
		if (round >= SNAPSHOT_LIMITS.readerRounds || files.size + missing.length > SNAPSHOT_LIMITS.readerFiles) {
			throw new SnapshotRefused('contract-too-large')
		}
		for (const path of missing) {
			const text = await commit.read(inRepository(path), SNAPSHOT_LIMITS.readerFileBytes)
			chars += text.length
			if (chars > SNAPSHOT_LIMITS.readerTotalChars) throw new SnapshotRefused('contract-too-large')
			files.set(path, text)
		}
	}
	const { contract: read, accessTables } = readContract(reader, files)
	if (read.contract.app !== appId) {
		throw new SnapshotRefused('contract-app-mismatch')
	}
	const { databaseCode, fileAdoptions, dataLoss } = readDatabaseCode(migrations, appId, settled, accessTables, dialect)
	const snapshot: AccessSnapshot = {
		version: 1,
		...read,
		migrations: migrations.map(({ name, checksum }) => ({ name, checksum })),
		...(databaseCode.length === 0 ? {} : { databaseCode }),
		...(fileAdoptions.length === 0 ? {} : { fileAdoptions }),
		...(dataLoss.length === 0 ? {} : { dataLoss }),
		checker: reader.checker,
		framework,
	}
	// Refused here, where the run log names it, rather than by the database when the run records it.
	if (!storedSnapshotFits(snapshot)) throw new SnapshotRefused('contract-too-large')
	return snapshot
}

function readContract(
	reader: ContractReader,
	files: ReadonlyMap<string, string>,
): { readonly contract: SnapshotContract; readonly accessTables: readonly string[] } {
	let outcome: ReaderOutcome
	try {
		outcome = reader.read(files)
	} catch {
		// An unexpected reader error may quote the checkout; only the code leaves this function.
		throw new SnapshotRefused('contract-unreadable')
	}
	if (!outcome.ok) throw new SnapshotRefused('contract-invalid', outcome.problems)
	return { contract: outcome.contract, accessTables: outcome.accessTables }
}

/**
 * The deviations, file adoptions and data loss of every migration file, classified as one set against the application's schema,
 * as the runner classifies them before it applies one. A refused statement in a file not yet settled fails the read:
 * the runner would refuse the file.
 */
function readDatabaseCode(
	migrations: readonly ReadMigration[],
	appId: string,
	settled: readonly MigrationEntry[],
	accessTables: readonly string[],
	dialect: MigrationDialect,
): { databaseCode: MigrationDeviation[]; fileAdoptions: FileAdoption[]; dataLoss: MigrationDataLoss[] } {
	if (migrations.length === 0) return { databaseCode: [], fileAdoptions: [], dataLoss: [] }
	let classified: MigrationSetClassification
	try {
		classified = classifyMigrations(migrations, applicationDatabaseSchema(appId), { accessTables: new Set(accessTables), dialect })
	} catch {
		// An unexpected classifier error may quote the checkout; only the code leaves this function.
		throw new SnapshotRefused('migrations-unreadable')
	}
	const settledChecksums = new Map(settled.map((entry) => [entry.name, entry.checksum]))
	const pending = new Set(migrations.filter((migration) => settledChecksums.get(migration.name) !== migration.checksum).map(({ name }) => name))
	const refused = classified.files.filter((file) => pending.has(file.file)).reduce((count, file) => count + file.refused.length, 0)
	if (refused > 0) throw new SnapshotRefused('migrations-refused', refused)
	return {
		databaseCode: classified.files.flatMap((file) => file.deviations),
		fileAdoptions: classified.files.flatMap((file) => file.adoptions),
		dataLoss: classified.files.flatMap((file) => file.dataLoss),
	}
}

/**
 * The runners' checksum rule (ADR-0017): a file the ledger records refuses the deploy when the SHA-256 of its text
 * differs, byte for byte, line ends and whitespace included, except a leading UTF-8 BOM: the commit's decoder drops it
 * and the Postgres runner keeps it, so a BOM-only edit is left to the runner. A recorded file the commit no longer holds
 * is tolerated, as both runners tolerate a database ahead of the code; a file no runner applies is not compared.
 */
function changedAppliedMigrations(applied: readonly MigrationEntry[], migrations: readonly MigrationEntry[]): string[] {
	const recorded = new Map(applied.filter(({ name }) => isBundledMigration(name)).map((entry) => [entry.name, entry.checksum]))
	return migrations.filter(({ name, checksum }) => recorded.has(name) && recorded.get(name) !== checksum).map(({ name }) => name)
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
