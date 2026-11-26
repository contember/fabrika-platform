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
	let current: StoredRecord | null = initial === null ? null : { record: initial, version: 'v0' }
	let versions = 0
	let failingPuts = 0
	let failingRead = false
	const written: OpsMigrationRecord[] = []
	return {
		get current() {
			return current
		},
		written,
		failPuts(count) {
			failingPuts = count
		},
		failRead() {
			failingRead = true
		},
		replace(record) {
			current = record === null ? null : { record, version: `v${++versions}x` }
		},
		async read() {
			if (failingRead) {
				failingRead = false
				throw new Error('R2 is unavailable')
			}
			return current
		},
		async put(record, version) {
			if (failingPuts > 0) {
				failingPuts--
				throw new Error('R2 is unavailable')
			}
			if ((current?.version ?? null) !== version) {
				return null
			}
			// What R2 would store and give back: the wire's parser refuses a record the object should never write.
			const stored = parseOpsMigrationRecord(JSON.parse(JSON.stringify(record)))
			if (stored === null) {
				throw new Error('the object put a migration record that does not parse')
			}
			current = { record: stored, version: `v${++versions}` }
			written.push(stored)
			return current.version
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

	/** Makes `count` puts throw, as an R2 outage does, after `after` more have landed. */
	failPuts(count: number, after = 0): void {
		this.#skip = after
		this.#failing = count
	}

	get = (key: string) => {
		const stored = this.objects.get(key)
		return Promise.resolve(stored === undefined ? null : { etag: stored.etag, text: () => Promise.resolve(stored.body) })
	}

	put = (key: string, body: unknown, options: { readonly onlyIf: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string } }) => {
		if (typeof body !== 'string') return Promise.reject(new Error('a migration record is JSON text'))
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
