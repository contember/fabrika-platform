// A migration record store in memory, with R2's conditional put, and faults a test switches on.

import { type OpsMigrationRecord, parseOpsMigrationRecord } from '@fabrika/auth-core'
import type { MigrationRecordStore, StoredRecord } from '../../cloudflare/migration-record'

export interface MemoryRecords extends MigrationRecordStore {
	/** What the store holds, as R2 would answer it. */
	readonly current: StoredRecord | null
	/** Every record put that landed, in order. */
	readonly written: readonly OpsMigrationRecord[]
	/** Makes the next `count` puts throw, as an R2 outage does. */
	failPuts(count: number): void
	/** Makes the next read throw. */
	failRead(): void
	/** Replaces what the store holds behind the object's back: another writer. */
	replace(record: OpsMigrationRecord | null): void
}

export function memoryRecords(initial: OpsMigrationRecord | null = null): MemoryRecords {
	// The JSON text R2 holds: a put stores what it is given, and only a read parses it, as `r2MigrationRecordStore` does.
	let stored: { readonly body: string; readonly version: string } | null = initial === null ? null : { body: JSON.stringify(initial), version: 'v0' }
	let versions = 0
	let failingPuts = 0
	let failingRead = false
	const written: OpsMigrationRecord[] = []
	const parsed = (): StoredRecord | null => {
		if (stored === null) return null
		const record = parseOpsMigrationRecord(JSON.parse(stored.body))
		if (record === null) {
			throw new Error('the migration record in R2 does not parse')
		}
		return { record, version: stored.version }
	}
	return {
		get current() {
			return parsed()
		},
		written,
		failPuts(count) {
			failingPuts = count
		},
		failRead() {
			failingRead = true
		},
		replace(record) {
			stored = record === null ? null : { body: JSON.stringify(record), version: `v${++versions}x` }
		},
		async read() {
			if (failingRead) {
				failingRead = false
				throw new Error('R2 is unavailable')
			}
			return parsed()
		},
		async put(record, version) {
			if (failingPuts > 0) {
				failingPuts--
				throw new Error('R2 is unavailable')
			}
			if ((stored?.version ?? null) !== version) {
				return null
			}
			stored = { body: JSON.stringify(record), version: `v${++versions}` }
			written.push(record)
			return stored.version
		},
	}
}

/** The store of an object that never migrated under a record and is never asked to: every test that needs none. */
export const noMigrationRecord: MigrationRecordStore = {
	read: async () => null,
	put: () => Promise.reject(new Error('no migration record is written here')),
}

/** Whether `key` is an object's migration record in the environment's bucket. */
export function isMigrationRecordKey(key: string): boolean {
	return /^__fabrika\/ops\/[a-z0-9-]+\.migration\.json$/.test(key)
}

/** R2's get and conditional put of the migration records, which a test's bucket double hands those keys to. */
export class RecordObjects {
	readonly objects = new Map<string, { readonly body: string; readonly etag: string }>()
	/** Every record body put that landed, in order. */
	readonly written: string[] = []
	#versions = 0
	#skip = 0
	#failing = 0

	/** Runs before each put is applied, so a test can write the record as another writer would. */
	beforePut: ((key: string) => void) | null = null
	#failingReads = 0

	/** Makes the next `count` reads throw. */
	failReads(count: number): void {
		this.#failingReads = count
	}

	/** Makes `count` puts throw, as an R2 outage does, after `after` more have landed. */
	failPuts(count: number, after = 0): void {
		this.#skip = after
		this.#failing = count
	}

	get = (key: string) => {
		if (this.#failingReads > 0) {
			this.#failingReads--
			return Promise.reject(new Error('R2 is unavailable'))
		}
		const stored = this.objects.get(key)
		return Promise.resolve(stored === undefined ? null : { etag: stored.etag, text: () => Promise.resolve(stored.body) })
	}

	put = (key: string, body: unknown, options: { readonly onlyIf: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string } }) => {
		if (typeof body !== 'string') return Promise.reject(new Error('a migration record is JSON text'))
		this.beforePut?.(key)
		if (this.#skip > 0) {
			this.#skip--
		} else if (this.#failing > 0) {
			this.#failing--
			return Promise.reject(new Error('R2 is unavailable'))
		}
		const stored = this.objects.get(key)
		const { etagMatches, etagDoesNotMatch } = options.onlyIf
		if ((etagMatches !== undefined && stored?.etag !== etagMatches) || (etagDoesNotMatch === '*' && stored !== undefined)) {
			return Promise.resolve(null)
		}
		const etag = `r${++this.#versions}`
		this.objects.set(key, { body, etag })
		this.written.push(body)
		return Promise.resolve({ etag })
	}

	/** The record stored for `object`, parsed. */
	record(object: string): OpsMigrationRecord | null {
		const stored = this.objects.get(`__fabrika/ops/${object}.migration.json`)
		return stored === undefined ? null : parseOpsMigrationRecord(JSON.parse(stored.body))
	}
}
