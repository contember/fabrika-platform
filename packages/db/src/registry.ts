// Which objects `scoped` created, and the framework side of each. Module-private state: the only readers are
// `store.ts`, which registers and builds the framework's stores, `framework.ts`, which `@fabrika/app` alone imports, and `testing.ts`, which only test
// files may import.

import type { Session } from './database'
import type { FileTables } from './file-tables'
import type { FormAdmissions, InboxQuota } from './form-admissions'
import type { FormFiles, HeldFormFiles } from './form-files'
import type { WebhookTables } from './framework-tables'
import type { JobLeases } from './job-leases'
import type { DataAccess } from './orm'
import type { DataLayerRuntime, TableContext, TableProbe } from './store'
import type { StoredFiles } from './stored-files'

/**
 * Answers what the framework's access check reads from the database: an object's containers, by dimension. `using` is
 * the session to read in (a job's transaction, which sees the object it just wrote); a statement of its own otherwise.
 */
export type Locator = (dimension: string, id: string, using?: Session) => Promise<ReadonlyMap<string, string> | null>

/** What the framework writes itself: a form's inbox row and its own `fabrika_*` tables. Usable once bound. */
export interface FrameworkTables {
	/** Why `fields` of form `form` cannot be appended to an inbox table of this layer; empty when they can. */
	inboxProblems(form: string, fields: readonly string[]): readonly string[]
	/**
	 * Appends one row of `values` (column → value) to the inbox table of `form`, taking one from `quota` in the same
	 * transaction, and makes the submission's `held` files held in it too; `false`, with nothing written, when the
	 * bucket is full.
	 */
	appendToInbox(form: string, values: Readonly<Record<string, unknown>>, quota: InboxQuota, held?: HeldFormFiles): Promise<boolean>
	readonly webhooks: WebhookTables
	readonly jobs: JobLeases
	/** A form's admission counters and the challenge tokens it accepted. */
	readonly forms: FormAdmissions
	/** The files forms received, until the job that drains each inbox attaches them to their owner. */
	readonly formFiles: FormFiles
	/** Every stored file (`fabrika_files`): staged before its object, claimed at its first reference, swept unreferenced. */
	readonly files: StoredFiles
}

export interface FrameworkSide {
	/** Connects the layer once and answers its locator; a second call throws. */
	bind(runtime: DataLayerRuntime): Locator
	/** The rows of the file collections' tables; usable once bound. */
	readonly files: FileTables
	readonly framework: FrameworkTables
	/** The untyped handle over one table that `@fabrika/db/testing` hands the isolation tests. */
	probe(table: string): TableProbe
	/** One table's context, for the framework's own store builders (`defineStore`, `@fabrika/db/testing`). */
	tableContext(table: string, mode: 'dimension' | 'child'): TableContext
	/** The mini-ORM: invocation transactions and the handles of `ctx.db`; usable once bound. */
	readonly data: DataAccess
}

// Captured when the module loads, before application code: a later patch to WeakMap does not change the registry.
const registry = new WeakMap<object, FrameworkSide>()
const weakGet: (this: WeakMap<object, FrameworkSide>, key: object) => FrameworkSide | undefined = WeakMap.prototype.get
const weakSet: (this: WeakMap<object, FrameworkSide>, key: object, value: FrameworkSide) => WeakMap<object, FrameworkSide> = WeakMap.prototype.set
const apply = Reflect.apply

export function register(database: object, side: FrameworkSide): void {
	apply(weakSet, registry, [database, side])
}

/** The framework side of an object `scoped` created; undefined for anything else, a structural copy included. */
export function frameworkSideOf(value: unknown): FrameworkSide | undefined {
	return typeof value === 'object' && value !== null ? apply(weakGet, registry, [value]) : undefined
}
