// Which objects `scoped` created, and the framework side of each. Module-private state: the only readers are
// `store.ts`, which registers, and `framework.ts`, which `@fabrika/app` alone imports.

import type { FileTables } from './file-tables'
import type { WebhookTables } from './framework-tables'
import type { JobLeases } from './job-leases'
import type { DataLayerRuntime } from './store'

/** Answers what the framework's access check reads from the database: an object's containers, by dimension. */
export type Locator = (dimension: string, id: string) => Promise<ReadonlyMap<string, string> | null>

/** What the framework writes itself: a form's inbox row and its own `fabrika_*` tables. Usable once bound. */
export interface FrameworkTables {
	/** Why `fields` of form `form` cannot be appended to an inbox table of this layer; empty when they can. */
	inboxProblems(form: string, fields: readonly string[]): readonly string[]
	/** Appends one row of `values` (column → value) to the inbox table of `form`. */
	appendToInbox(form: string, values: Readonly<Record<string, unknown>>): Promise<void>
	readonly webhooks: WebhookTables
	readonly jobs: JobLeases
}

export interface FrameworkSide {
	/** Connects the layer once and answers its locator; a second call throws. */
	bind(runtime: DataLayerRuntime): Locator
	/** The rows of the file collections' tables; usable once bound. */
	readonly files: FileTables
	readonly framework: FrameworkTables
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
