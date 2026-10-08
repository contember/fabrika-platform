// Which objects `scoped` created, and the framework side of each. Module-private state: the only readers are
// `store.ts`, which registers, and `framework.ts`, which `@fabrika/app` alone imports.

import type { DataLayerRuntime } from './store'

/** Scope values of one container dimension: `organization → [o1, o2]`. */
export interface ContainerValues {
	readonly dimension: string
	readonly values: readonly string[]
}

/**
 * What the framework's access check reads from the database, generated from the table policies. It reads without
 * a capability, so only the framework holds it.
 */
export interface Locator {
	/** The containers one object lies in, by dimension, or `null` when the table that owns `dimension` has no such row. */
	locate(dimension: string, id: string): Promise<ReadonlyMap<string, string> | null>
	/** The values of `dimension` that lie in any of `containers`: what a grant on a container reaches. */
	contained(dimension: string, containers: readonly ContainerValues[]): Promise<readonly string[]>
}

export interface FrameworkSide {
	/** Connects the layer once and answers its locator; a second call throws. */
	bind(runtime: DataLayerRuntime): Locator
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
