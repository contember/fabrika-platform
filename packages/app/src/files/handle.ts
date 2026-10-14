// `ctx.files`: a handler's and a job's handle on the contract's file collections. Types only, so the browser-safe
// contract can name them; `collections.ts` builds the handle. Every operation takes a `Ref` of the owner for one of the
// collection's actions, so a file reaches what its owner reaches, as through the generated endpoints.

import type { Unavailable } from '@fabrika/db/tables'
import type { Ref } from '../implement/capability'

/** A held file's state: served when `live`, `409` while `quarantined`, gone when `rejected`. */
export type HeldFileStatus = 'live' | 'quarantined' | 'rejected'

/** One file of an owner, as `list` answers it. */
export interface ListedFile {
	readonly id: string
	/** The name the uploader gave it, metadata only. */
	readonly name: string | null
	/** The sniffed media type its bytes were checked against. */
	readonly type: string
	readonly size: number
	readonly status: HeldFileStatus
	readonly createdAt: Date
}

/** A page of an owner's files, oldest first; `next` is the `after` of the following page, `null` after the last. */
export interface FileListing {
	readonly items: readonly ListedFile[]
	readonly next: string | null
}

export interface FileListPage {
	/** The id of the last file of the previous page. */
	readonly after?: string
	/** 1–100, 50 by default. */
	readonly limit?: number
}

/** A live file read whole: what an e-mail attaches. */
export interface OpenedFile {
	readonly id: string
	readonly name: string | null
	readonly type: string
	readonly size: number
	readonly bytes: Uint8Array
}

export interface OpenOptions {
	/** The most bytes the caller holds in memory; a larger file is refused (413 `too_large`) before it is read. */
	readonly maxBytes: number
}

/** What every site reaches of one collection: its owner's files. */
export interface FileCollectionReader {
	/**
	 * The owner's held files, oldest first; `owner` is a `Ref` of the collection's owner for its `read` action. A
	 * handler that must see the uploads holds that action.
	 */
	list(owner: Ref<string, string>, page?: FileListPage): Promise<FileListing>
	/**
	 * The live file `id` of the owner, read whole; `owner` is a `Ref` for the collection's `read` action. A file of
	 * another owner, a rejected or a removed one is 404, a quarantined one 409 `quarantined`, one over `maxBytes` 413.
	 */
	open(owner: Ref<string, string>, id: string, options: OpenOptions): Promise<OpenedFile>
}

/** A site that writes also removes: a mutation, and a job inside `ctx.transaction`. */
export interface FileCollectionHandle extends FileCollectionReader {
	/**
	 * Marks every file of the owner removed, in this site's transaction, and answers how many; `owner` is a `Ref` for the
	 * collection's `delete` action. The framework's sweep deletes their objects after the commit.
	 */
	removeAll(owner: Ref<string, string>): Promise<number>
}

/** A site that only reads: a query, and a job outside `ctx.transaction`. */
export type FileCollectionReadHandle<Why extends string> = FileCollectionReader & { readonly removeAll: Unavailable<Why> }

/** `ctx.files(<collection>)`: the handle of one collection of the contract, by its name in `files`. */
export type FileCollections<H> = (collection: string) => H
