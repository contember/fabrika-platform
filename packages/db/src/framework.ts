// @fabrika/db/framework — for `@fabrika/app`'s `boot` only; the checker refuses an application import of it. It binds
// the data layer an application passed to `implement` to the framework's connection and capability authority, and
// hands the framework the locator its access check uses. Browser- and Worker-safe: the Worker adapter imports `boot`.

import type { FileTables } from './file-tables'
import type { DataAccess } from './orm'
import { frameworkSideOf, type FrameworkTables, type Locator } from './registry'
import type { DataLayerRuntime } from './store'

export type { LeaseFence } from './capability'
export type { InvocationTransaction, Session } from './database'
export { LeaseLostError, QueryRefusedError } from './errors'
export { fileTableName } from './file-table-sql'
export type { FileCollectionSpec, FileCollectionTable, FileTables, LiveFile, PendingFile, RemovableFile } from './file-tables'
export type { NewWebhookBinding, WebhookBinding, WebhookTables } from './framework-tables'
export type { JobLeases, JobLeaseState, JobOutcome, OverdueClaim } from './job-leases'
export type { DataAccess, DataHandles, DataSite } from './orm'
export type { FrameworkTables, Locator } from './registry'
export type { SqlMode, SqlSite, SqlTag, SqlValue } from './sql'

/** Whether `value` is an object `scoped(tables)` created, rather than a look-alike with the same fields. */
export function isScopedDatabase(value: unknown): boolean {
	return frameworkSideOf(value) !== undefined
}

/**
 * Connects the layer `scoped(tables)` created to `runtime`, once, and answers its locator, which nothing else can
 * reach. Throws for any other value and for a layer that is already connected.
 */
export function bindScopedDatabase(value: unknown, runtime: DataLayerRuntime): Locator {
	const side = frameworkSideOf(value)
	if (side === undefined) {
		throw new TypeError('not a data layer scoped(tables) created')
	}
	return side.bind(runtime)
}

/** The file collections' tables of the layer `scoped(tables)` created; each operation needs the layer bound first. */
export function fileTablesOf(value: unknown): FileTables {
	const side = frameworkSideOf(value)
	if (side === undefined) {
		throw new TypeError('not a data layer scoped(tables) created')
	}
	return side.files
}

/**
 * The framework's own writes over the layer `scoped(tables)` created: inbox appends for `c.form` and the webhook
 * tables. Each operation needs the layer bound first. Throws for any other value.
 */
export function frameworkTablesOf(value: unknown): FrameworkTables {
	const side = frameworkSideOf(value)
	if (side === undefined) {
		throw new TypeError('not a data layer scoped(tables) created')
	}
	return side.framework
}

/**
 * The mini-ORM of the layer `scoped(tables)` created: the invocation transactions and the `ctx.db` handles the
 * framework builds per site. Each operation needs the layer bound first. Throws for any other value.
 */
export function dataAccessOf(value: unknown): DataAccess {
	const side = frameworkSideOf(value)
	if (side === undefined) {
		throw new TypeError('not a data layer scoped(tables) created')
	}
	return side.data
}
