// The sweep's retention window over a bun:sqlite stand-in for a Durable Object's storage: a removed file's object
// outlives its row by the window, so a restored backup's rows still find it, and a cancelled tombstone keeps its object,
// even one the sweep already read as due. With no window, as on Bun, the sweep deletes the object in the run that
// removes the row.

import { SQLITE_FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations-sqlite'
import { openSqlite } from '@fabrika/db/sqlite'
import { migrateSqlite } from '@fabrika/db/sqlite-migrate'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { type StoredFiles, storedFiles } from '../../../db/src/stored-files'
import { FILE_TOMBSTONE_RETENTION_MS, StoredFileKinds } from '../files/kinds'
import { createCapabilityIssuer } from '../implement/capability'

const KIND = { name: 'attachments', artifact: { types: ['application/pdf'], maxBytes: 1024 } }

/** An object store whose deletion of one key waits until the test lets it finish. */
class GatedObjects extends MemoryFileObjects {
	readonly #gated: { key: string; reached: () => void; release: Promise<void> } | null

	constructor(gated: { key: string; reached: () => void; release: Promise<void> } | null = null) {
		super()
		this.#gated = gated
	}

	override async delete(key: string): Promise<void> {
		if (this.#gated?.key === key) {
			this.#gated.reached()
			await this.#gated.release
		}
		await super.delete(key)
	}
}

interface World {
	readonly files: StoredFiles
	readonly store: GatedObjects
	readonly kinds: StoredFileKinds
	readonly exec: (query: string, ...bindings: string[]) => void
}

async function world(retentionMs: number, store = new GatedObjects()): Promise<World> {
	const storage = bunSqliteStorage()
	await migrateSqlite({ exec: storage.sql.exec, transactionSync: (fn) => storage.transactionSync(fn) }, [
		{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS },
	])
	const database = openSqlite(storage)
	const { authority } = createCapabilityIssuer()
	const files = storedFiles(() => ({ database, capabilities: authority }))
	return {
		files,
		store,
		kinds: new StoredFileKinds([KIND], store, files, [], retentionMs),
		exec: (query, ...bindings) => void storage.sql.exec(query, ...bindings).toArray(),
	}
}

/** Every queued key, however recent. */
function queued({ files }: World): Promise<readonly string[]> {
	return files.dueDeletions(10, new Date())
}

/** A file whose row and object exist, past the pending grace, that no column references. */
async function orphan({ files, store, exec }: World, key?: string): Promise<string> {
	const id = Bun.randomUUIDv7()
	const objectKey = key ?? `${KIND.name}/${id}`
	await files.stage({ id, kind: KIND.name, objectKey, contentType: 'application/pdf', name: null, request: 'request-1' })
	store.replace(objectKey, new TextEncoder().encode('%PDF'), 'application/pdf')
	exec(`update fabrika_files set created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours') where id = ?`, id)
	return objectKey
}

function backdateDeletion({ exec }: World, key: string, days: number): void {
	exec(`update fabrika_file_deletions set recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) where object_key = ?`, `-${days} days`, key)
}

describe('the sweep with a retention window', () => {
	test('removes the row and keeps the object inside the window; past it, it deletes the object', async () => {
		const at = await world(FILE_TOMBSTONE_RETENTION_MS)
		const key = await orphan(at)
		await at.kinds.sweep(new AbortController().signal)
		expect(at.store.objects.has(key)).toBe(true)
		expect(await queued(at)).toEqual([key])
		backdateDeletion(at, key, 29)
		await at.kinds.sweep(new AbortController().signal)
		expect(at.store.objects.has(key)).toBe(true)
		backdateDeletion(at, key, 31)
		await at.kinds.sweep(new AbortController().signal)
		expect(at.store.objects.has(key)).toBe(false)
		expect(await queued(at)).toEqual([])
	})

	test('keeps the object of a cancelled tombstone past the window', async () => {
		const at = await world(FILE_TOMBSTONE_RETENTION_MS)
		const cancelled = await orphan(at)
		const deleted = await orphan(at)
		await at.kinds.sweep(new AbortController().signal)
		backdateDeletion(at, cancelled, 31)
		backdateDeletion(at, deleted, 31)
		expect(await at.files.cancelDeletions([cancelled])).toBe(1)
		await at.kinds.sweep(new AbortController().signal)
		expect(at.store.objects.has(cancelled)).toBe(true)
		expect(at.store.objects.has(deleted)).toBe(false)
	})

	test('with no window, as on Bun, deletes the object in the run that removes the row', async () => {
		const at = await world(0)
		const key = await orphan(at)
		await at.kinds.sweep(new AbortController().signal)
		expect(at.store.objects.has(key)).toBe(false)
		expect(await queued(at)).toEqual([])
	})

	test('a cancel that lands while the sweep deletes another due object keeps its own object', async () => {
		let reached = () => {}
		const atDelete = new Promise<void>((resolve) => {
			reached = resolve
		})
		let release = () => {}
		const released = new Promise<void>((resolve) => {
			release = resolve
		})
		const at = await world(FILE_TOMBSTONE_RETENTION_MS, new GatedObjects({ key: 'attachments/first', reached: () => reached(), release: released }))
		const first = await orphan(at, 'attachments/first')
		const second = await orphan(at)
		await at.kinds.sweep(new AbortController().signal)
		backdateDeletion(at, first, 40)
		backdateDeletion(at, second, 31)
		const sweeping = at.kinds.sweep(new AbortController().signal)
		await atDelete
		let cancelled = false
		const cancelling = at.kinds.cancelDeletions([second]).then((count) => {
			cancelled = true
			return count
		})
		await Bun.sleep(5)
		// No deletion is in flight once a cancel resolves: this one waits for the deletion of the first object.
		expect(cancelled).toBe(false)
		release()
		expect(await cancelling).toBe(1)
		await sweeping
		expect(at.store.objects.has(first)).toBe(false)
		expect(at.store.objects.has(second)).toBe(true)
		expect(await queued(at)).toEqual([])
	})

	test('with no window, a key queued again does not stop the sweep, which deletes the object', async () => {
		const at = await world(0)
		const key = await orphan(at)
		// A removal whose object deletion never ran: the key stays queued, and a new row takes the same key.
		const [id] = await at.files.unreferenced([], 1, 1)
		if (id === undefined) throw new Error('no unreferenced file')
		expect(await at.files.remove(id, 1)).toBe(key)
		await orphan(at, key)
		await at.kinds.sweep(new AbortController().signal)
		await at.kinds.sweep(new AbortController().signal)
		expect(at.store.objects.has(key)).toBe(false)
		expect(await queued(at)).toEqual([])
	})
})
