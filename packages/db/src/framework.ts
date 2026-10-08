// @fabrika/db/framework — for `@fabrika/app`'s `boot` only; the checker refuses an application import of it. It binds
// the data layer an application passed to `implement` to the framework's connection and capability authority, and
// hands the framework the locator its access checks use. Browser- and Worker-safe: the Worker adapter imports `boot`.

import { frameworkSideOf, type Locator } from './registry'
import type { DataLayerRuntime } from './store'

export type { ContainerValues, Locator } from './registry'

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
