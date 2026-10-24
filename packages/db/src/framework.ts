// @fabrika/db/framework — for `@fabrika/app`'s `boot` only; the checker refuses an application import of it. It binds
// the data layer an application passed to `implement` to the framework's connection and capability authority, and
// hands the framework the locator its access check uses. Browser- and Worker-safe: the Worker adapter imports `boot`.

import type { DataAccess } from './orm'
import { frameworkSideOf, type FrameworkTables, type Locator, type ProvisionalBinding } from './registry'
import type { DataLayerRuntime } from './store'

export type { Admissions } from './admissions'
export type { LeaseFence } from './capability'
export type { InvocationTransaction, Session } from './database'
export {
	CAPABILITY_ERRORS,
	CapabilityError,
	type CapabilityErrorReason,
	LeaseLostError,
	QUERY_REFUSALS,
	type QueryRefusal,
	QueryRefusedError,
} from './errors'
export type { FileBinding } from './file-columns'
export { type FileHolding, fileHoldingOf, type FileReference, fileReference, holdsFile } from './file-references'
export type { DeliveryClaim, NewWebhookBinding, WebhookBinding, WebhookTables } from './framework-tables'
export type { JobLeases, JobLeaseState, JobOutcome, OverdueClaim } from './job-leases'
export type { DataAccess, DataHandles, DataSite } from './orm'
export type { FrameworkTables, Locator, ProvisionalBinding } from './registry'
export type { SqlMode, SqlSite, SqlTag, SqlValue } from './sql'
export type { FileColumnRef, QuarantinedStoredFile, ServedFile, StagedFile, StoredFileMeta, StoredFiles, StoredFileStatus } from './stored-files'

/** Whether `value` is an object `scoped(tables)` created, rather than a look-alike with the same fields. */
export function isScopedDatabase(value: unknown): boolean {
	return frameworkSideOf(value) !== undefined
}

/**
 * Connects the layer `scoped(tables)` created to `runtime`, once, and answers its locator, which nothing else can
 * reach. Throws for any other value and for a layer that is already connected.
 */
export function bindScopedDatabase(value: unknown, runtime: DataLayerRuntime): Locator {
	return bindScopedDatabaseProvisionally(value, runtime).locate
}

/**
 * Connects the layer like `bindScopedDatabase`, and answers with its locator the `release` that disconnects it again:
 * a boot that fails releases the layer, so a later boot of the same application binds it. Throws as that does.
 */
export function bindScopedDatabaseProvisionally(value: unknown, runtime: DataLayerRuntime): ProvisionalBinding {
	const side = frameworkSideOf(value)
	if (side === undefined) {
		throw new TypeError('not a data layer scoped(tables) created')
	}
	return side.bind(runtime)
}

/**
 * The framework's own writes over the layer `scoped(tables)` created: the webhook tables, the job leases and the
 * admission counters. Each operation needs the layer bound first. Throws for any other value.
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
