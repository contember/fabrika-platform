// The migrating boot of an application's object (ADR-0069 §3): the migration record in the environment's bucket, the
// bookmark it names, every pending file of both bundles in one transaction, and `booted` before the first ordinary
// event. The record lives in R2, never in SQLite or KV, which point-in-time recovery rewinds.

import {
	OPS_MIGRATION_RECORD_KEY,
	type OpsMigrationFailureReason,
	type OpsMigrationOutcome,
	type OpsMigrationRecord,
	parseOpsMigrationRecord,
} from '@fabrika/auth-core'
import {
	planSqliteMigrations,
	readSqliteLedger,
	type SqliteLedger,
	type SqliteMigrationBundle,
	type SqliteMigrationTarget,
} from '@fabrika/db/sqlite-migrate'
import { uuidv7 } from '@fabrika/platform'
import { method } from './bindings.js'

/** The record R2 holds, and its version: the etag a conditional put names. */
export interface StoredRecord {
	readonly record: OpsMigrationRecord
	readonly version: string
}

/** The object's migration record. */
export interface MigrationRecordStore {
	/** `null` only for a definite not-found; every other failure throws, a record that does not parse included. */
	read(): Promise<StoredRecord | null>
	/** Puts `record` if R2 still holds `version` (`null`: holds nothing); the new version, or `null` when the condition failed. */
	put(record: OpsMigrationRecord, version: string | null): Promise<string | null>
}

/** `__fabrika/ops/<object>.migration.json` in the environment's bucket (`bucket`, an R2 binding). */
export function r2MigrationRecordStore(bucket: unknown, object: string): MigrationRecordStore {
	const key = OPS_MIGRATION_RECORD_KEY(object)
	const call = (name: string): (...args: unknown[]) => unknown => {
		const found = method(bucket, name)
		if (found === null) {
			throw new Error(`the FABRIKA_FILES binding has no ${name}; the migration record lives in the environment's bucket`)
		}
		return found
	}
	return {
		async read() {
			const answer: unknown = await call('get')(key)
			if (answer === null) {
				return null
			}
			const version = typeof answer === 'object' ? Reflect.get(answer, 'etag') : undefined
			const text = method(answer, 'text')
			if (typeof version !== 'string' || version === '' || text === null) {
				throw new Error('R2 answered the migration record without its etag or body')
			}
			const body: unknown = await text()
			const record = typeof body === 'string' ? parseOpsMigrationRecord(parseJson(body)) : null
			if (record === null) {
				throw new Error('the migration record in R2 does not parse')
			}
			return { record, version }
		},
		async put(record, version) {
			const onlyIf = version === null ? { etagDoesNotMatch: '*' } : { etagMatches: version }
			const answer: unknown = await call('put')(key, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' }, onlyIf })
			if (answer === null) {
				return null
			}
			const etag = typeof answer === 'object' ? Reflect.get(answer, 'etag') : undefined
			if (typeof etag !== 'string' || etag === '') {
				throw new Error('R2 answered the migration record put without its etag')
			}
			return etag
		},
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/**
 * A put after the record's first could not land: R2 failed, or the record changed under it. Nothing is admitted; the
 * next event boots over, and reads from the record and the ledger what the transaction did, so it never migrates twice.
 */
export class RecordPending extends Error {
	override readonly name = 'RecordPending'
}

/** The migrating boot failed with a record: `record_unwritable` before the transaction, `rolled_back` after it. */
export class MigrationFailed extends Error {
	override readonly name = 'MigrationFailed'
	readonly reason: OpsMigrationFailureReason
	readonly record: OpsMigrationRecord

	constructor(reason: OpsMigrationFailureReason, record: OpsMigrationRecord, options?: ErrorOptions) {
		super(`the migrating boot failed: ${reason}`, options)
		this.reason = reason
		this.record = record
	}
}

export interface MigratingBootInput {
	readonly target: SqliteMigrationTarget
	readonly store: MigrationRecordStore
	readonly bundles: readonly SqliteMigrationBundle[]
	/** The Worker version that runs; `null` without the version metadata binding, which no rewind accepts. */
	readonly version: string | null
	/** `getCurrentBookmark()`; `null` where the storage has no point-in-time recovery. */
	readonly bookmark: () => Promise<string | null>
	/** Whether migrations may be applied: `false` on a restricted cold start, which only looks. */
	readonly apply: boolean
	readonly now?: () => Date
}

/** The boot found something to apply while it may not: a restricted cold start waits for the operation's `migrate`. */
export type MigratingBootResult = { readonly kind: 'pending' } | { readonly kind: 'ready'; readonly held: StoredRecord | null }

/**
 * Steps 2 to 4 of the migrating boot, after the reconciliation of a record without an outcome. Answers the record as R2
 * now holds it, which step 5 marks `booted` once the instance may admit its first ordinary event.
 */
export async function migratingBoot(input: MigratingBootInput): Promise<MigratingBootResult> {
	const now = input.now ?? (() => new Date())
	let held = await readRecord(input.store)
	if (held !== null && held.record.outcome === null) {
		held = await reconcile(input.store, input.target, input.bookmark, held)
	}
	const plan = await planSqliteMigrations(input.target, input.bundles)
	if (!plan.writes) {
		return { kind: 'ready', held }
	}
	if (!input.apply) {
		return { kind: 'pending' }
	}
	if (plan.pending.length === 0) {
		// Only a bundle digest is out of date: no schema changes, so no record.
		plan.apply()
		return { kind: 'ready', held }
	}
	const record: OpsMigrationRecord = {
		id: uuidv7(),
		version: input.version,
		bookmark: await bookmarkOf(input.bookmark),
		startDigest: (plan.ledger ?? (await readSqliteLedger(input.target))).digest,
		files: plan.pending,
		at: now().toISOString(),
		outcome: null,
		committedBookmark: null,
		booted: null,
	}
	// `held` has an outcome here: a record is replaced only once it has one.
	let version: string | null
	try {
		version = await input.store.put(record, held?.version ?? null)
	} catch (error) {
		throw new MigrationFailed('record_unwritable', record, { cause: error })
	}
	if (version === null) {
		throw new RecordPending('the migration record changed while the boot wrote a new one')
	}
	held = { record, version }
	try {
		plan.apply()
	} catch (error) {
		await update(input.store, held, { ...record, outcome: 'rolled_back' })
		throw new MigrationFailed('rolled_back', { ...record, outcome: 'rolled_back' }, { cause: error })
	}
	return {
		kind: 'ready',
		held: await update(input.store, held, { ...record, outcome: 'committed', committedBookmark: await bookmarkOf(input.bookmark) }),
	}
}

/**
 * After a boot that failed outside the migrating boot (a module or a boot check that throws): the record a commit left
 * without `booted`, reconciled first when it has no outcome. `migrate` answers it as the 422 `committed`, which is how
 * Control learns of a migration the object committed but never served. `null` without one; record I/O throws
 * `RecordPending`.
 */
export async function unbootedCommit(
	input: Pick<MigratingBootInput, 'target' | 'store' | 'bookmark'>,
): Promise<OpsMigrationRecord | null> {
	let held = await readRecord(input.store)
	if (held === null) {
		return null
	}
	if (held.record.outcome === null) {
		held = await reconcile(input.store, input.target, input.bookmark, held)
	}
	return held.record.outcome === 'committed' && held.record.booted === null ? held.record : null
}

/**
 * Step 5: `booted` into a record that lacks it, before the first ordinary event; a `rewound` record is never marked, so
 * the migration it undid never reads as served (ADR-0070 §9).
 */
export async function markBooted(
	store: MigrationRecordStore,
	held: StoredRecord | null,
	now: () => Date = () => new Date(),
): Promise<OpsMigrationRecord | null> {
	if (held === null || held.record.booted !== null || held.record.outcome === null || held.record.outcome === 'rewound') {
		return held?.record ?? null
	}
	return (await update(store, held, { ...held.record, booted: now().toISOString() })).record
}

/**
 * The outcome of a record without one, from its own rows in the ledger (ADR-0069 §3): the transaction is atomic, so
 * none is `rolled_back` and every one `committed`; some, or one with another checksum, only a release before the gate
 * leaves, and the record is `diverged`, never rewound, while the boot goes on.
 */
async function reconcile(
	store: MigrationRecordStore,
	target: SqliteMigrationTarget,
	bookmark: MigratingBootInput['bookmark'],
	held: StoredRecord,
): Promise<StoredRecord> {
	const outcome = reconciledOutcome(held.record, await readSqliteLedger(target))
	return await update(store, held, {
		...held.record,
		outcome,
		committedBookmark: outcome === 'committed' ? await bookmarkOf(bookmark) : null,
	})
}

/** A bookmark the storage could not give holds the boot back like a failed put: nothing is admitted, the next event retries. */
async function bookmarkOf(bookmark: MigratingBootInput['bookmark']): Promise<string | null> {
	try {
		return await bookmark()
	} catch (error) {
		throw new RecordPending('the bookmark could not be read', { cause: error })
	}
}

export function reconciledOutcome(record: OpsMigrationRecord, ledger: SqliteLedger): OpsMigrationOutcome {
	const checksums = new Map(ledger.entries.map((entry) => [`${entry.bundle}/${entry.name}`, entry.checksum]))
	const found = record.files.map((file) => checksums.get(`${file.bundle}/${file.name}`))
	if (found.every((checksum) => checksum === undefined)) {
		return 'rolled_back'
	}
	return record.files.every((file, index) => found[index] === file.checksum) ? 'committed' : 'diverged'
}

async function readRecord(store: MigrationRecordStore): Promise<StoredRecord | null> {
	try {
		return await store.read()
	} catch (error) {
		throw new RecordPending('the migration record could not be read', { cause: error })
	}
}

/**
 * A conditional put of `next` over the record held. On a conflict the record is read again; whatever R2 holds now, the
 * update is dropped and the boot starts over, which decides again from what it reads.
 */
export async function update(store: MigrationRecordStore, held: StoredRecord, next: OpsMigrationRecord): Promise<StoredRecord> {
	let version: string | null
	try {
		version = await store.put(next, held.version)
	} catch (error) {
		throw new RecordPending('the migration record could not be written', { cause: error })
	}
	if (version === null) {
		throw new RecordPending(`the migration record ${held.record.id} changed under its update`)
	}
	return { record: next, version }
}
