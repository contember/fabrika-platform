// Reading a run's access snapshot at its pinned commit (ADR-0050 §1): the contract graph and `src/db/tables.ts` through
// the static reader of the framework release the application pins (ADR-0062), which executes nothing (ADR-0005), the
// migration list with checksums, the database code the migrations declare, through the classifier the runner applies
// them with (ADR-0017), and the database a Cloudflare application chose in `fabrika.config.ts`.

import { sha256Hex } from '@fabrika/auth-core'
import {
	type ApplicationTarget,
	applicationTarget,
	CONFIG_FILE,
	CONTRACT_FILE,
	CONTRACT_LIMITS,
	lockedRegistryVersion,
	LOCKFILE,
	MIGRATIONS_DIR,
} from '@fabrika/check/contract'
import {
	applicationDatabaseSchema,
	classifyMigrations,
	type FileAdoption,
	type MigrationDeviation,
	type MigrationSetClassification,
} from '@fabrika/platform-node/sql'
import type { CommitFiles } from '../github/source/commit-files'
import type { SnapshotContract } from './formats'
import { type ContractReader, FRAMEWORK_PACKAGE, FrameworkReleaseRefused, readerFor, type ReaderOutcome } from './readers'
import type { AccessSnapshot, MigrationEntry } from './snapshot'

/** What one snapshot read may cost: files, rounds of import discovery, and bytes per file. */
export const SNAPSHOT_LIMITS = {
	readerFiles: 256,
	readerRounds: 32,
	readerFileBytes: CONTRACT_LIMITS.sourceBytes,
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
	| 'config-unreadable'

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
	const framework = await readFrameworkRelease(commit, inRepository)
	const reader = readerFor(framework)
	const migrations = await readMigrations(commit, root)
	const files = new Map<string, string>()
	for (let round = 0;; round++) {
		const missing = reader.inputs(files, exists)
		if (missing.length === 0) break
		if (round >= SNAPSHOT_LIMITS.readerRounds || files.size + missing.length > SNAPSHOT_LIMITS.readerFiles) {
			throw new SnapshotRefused('contract-too-large')
		}
		for (const path of missing) files.set(path, await commit.read(inRepository(path), SNAPSHOT_LIMITS.readerFileBytes))
	}
	const read = readContract(reader, files)
	if (read.contract.app !== appId) {
		throw new SnapshotRefused('contract-app-mismatch')
	}
	const { databaseCode, fileAdoptions } = readDatabaseCode(migrations, appId, settled)
	const database = await readDatabase(commit, inRepository, files)
	return {
		version: 1,
		...read,
		migrations: migrations.map(({ name, checksum }) => ({ name, checksum })),
		...(databaseCode.length === 0 ? {} : { databaseCode }),
		...(fileAdoptions.length === 0 ? {} : { fileAdoptions }),
		...(database === undefined ? {} : { database }),
		checker: reader.checker,
		framework,
	}
}

/**
 * The database a Cloudflare application chose in `fabrika.config.ts`, read statically as the checker reads it: Postgres
 * only when the `defineApp` argument states it, followed through `const` bindings. Every other configuration, an argument
 * the read cannot follow (`unsettled`) and a root without one choose none; the deployer refuses a `database` the loaded
 * config names that Control did not approve. A Cloudflare configuration that names `database` in a form the read cannot
 * settle is refused: the deployer would load a database Control never approved.
 */
async function readDatabase(
	commit: CommitFiles,
	inRepository: (path: string) => string,
	readerFiles: ReadonlyMap<string, string>,
): Promise<'postgres' | undefined> {
	if (!commit.paths.has(inRepository(CONFIG_FILE))) return undefined
	const text = readerFiles.get(CONFIG_FILE) ?? await commit.read(inRepository(CONFIG_FILE), SNAPSHOT_LIMITS.readerFileBytes)
	let target: ApplicationTarget
	try {
		target = applicationTarget(new Map([[CONFIG_FILE, text]]))
	} catch {
		// An unexpected reader error may quote the checkout; only the code leaves this function.
		throw new SnapshotRefused('config-unreadable')
	}
	if (target.unreadable !== undefined) throw new SnapshotRefused('config-unreadable')
	return target.cloudflare && target.dialect === 'postgres' ? 'postgres' : undefined
}

function readContract(reader: ContractReader, files: ReadonlyMap<string, string>): SnapshotContract {
	let outcome: ReaderOutcome
	try {
		outcome = reader.read(files)
	} catch {
		// An unexpected reader error may quote the checkout; only the code leaves this function.
		throw new SnapshotRefused('contract-unreadable')
	}
	if (!outcome.ok) throw new SnapshotRefused('contract-invalid', outcome.problems)
	return outcome.contract
}

/**
 * The deviations and file adoptions of every migration file, classified as one set against the application's schema,
 * as the runner classifies them before it applies one. A refused statement in a file not yet settled fails the read:
 * the runner would refuse the file.
 */
function readDatabaseCode(
	migrations: readonly ReadMigration[],
	appId: string,
	settled: readonly MigrationEntry[],
): { databaseCode: MigrationDeviation[]; fileAdoptions: FileAdoption[] } {
	if (migrations.length === 0) return { databaseCode: [], fileAdoptions: [] }
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
	return { databaseCode: classified.files.flatMap((file) => file.deviations), fileAdoptions: classified.files.flatMap((file) => file.adoptions) }
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
