// File references: the request-bound values a file column holds. The data layer answers one for each file column of a
// row it reads, and `@fabrika/app` mints one for a file a request received or put; a file column takes nothing else. A
// reference is a frozen object of the file's metadata, registered here with the work it belongs to: a reference of
// another request, or one read under an action that does not read the file, is refused where it is written or served.

import { freeze } from './builtins'
import type { StoredFileMeta, StoredFileStatus } from './stored-files'

/** What a handler sees of a stored file: its metadata, never its object. */
export interface FileReference {
	readonly id: string
	readonly name: string | null
	readonly type: string
	readonly size: number
	readonly status: StoredFileStatus
}

/** Whose a reference is, and what it lets that work do. */
export interface FileHolding {
	readonly id: string
	readonly kind: string
	/** The work that holds it: one request, or one job attempt. */
	readonly holder: object
	/** Read under an action that reads the file (or received, or put): it may be written into a column, served and opened. */
	readonly readable: boolean
}

// Captured when the module loads, before application code: a later patch to WeakMap does not change the registry.
const holdings = new WeakMap<object, FileHolding>()
const readableIds = new WeakMap<object, Set<string>>()
const apply = Reflect.apply
const getHolding: (this: WeakMap<object, FileHolding>, key: object) => FileHolding | undefined = WeakMap.prototype.get
const setHolding: (this: WeakMap<object, FileHolding>, key: object, value: FileHolding) => WeakMap<object, FileHolding> = WeakMap.prototype.set
const getReadable: (this: WeakMap<object, Set<string>>, key: object) => Set<string> | undefined = WeakMap.prototype.get
const setReadable: (this: WeakMap<object, Set<string>>, key: object, value: Set<string>) => WeakMap<object, Set<string>> = WeakMap.prototype.set

/**
 * A reference to a file for `holder`; only `@fabrika/db` and the framework mint one. A `readable` one also lets its
 * holder write the file into a column, serve it and open it, through any reference to the same file.
 */
export function fileReference(meta: StoredFileMeta, holder: object, readable: boolean): FileReference {
	const reference: FileReference = freeze({ id: meta.id, name: meta.name, type: meta.type, size: meta.size, status: meta.status })
	apply(setHolding, holdings, [reference, freeze({ id: meta.id, kind: meta.kind, holder, readable })])
	if (readable) {
		const ids = apply(getReadable, readableIds, [holder]) ?? new Set<string>()
		ids.add(meta.id)
		apply(setReadable, readableIds, [holder, ids])
	}
	return reference
}

/** What a reference holds, or `undefined` for any other value: a structural copy, a string id or a forged object. */
export function fileHoldingOf(value: unknown): FileHolding | undefined {
	return typeof value === 'object' && value !== null ? apply(getHolding, holdings, [value]) : undefined
}

/** Whether `holder` received, put, or read under a read action the file `id`. */
export function holdsFile(holder: object, id: string): boolean {
	return apply(getReadable, readableIds, [holder])?.has(id) === true
}
