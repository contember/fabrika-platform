// What the staged kit keeps beside a declaration, out of the declaration itself: a site's handler and a contract's
// vendored snapshots and whether its kit had tables. `compileContract` and the static reader see only the declaration; `serve` reads these.
// Browser-safe: a handler is held here, never called.

import type { ConnectSnapshot } from './connect'

const handlers = new WeakMap<object, unknown>()

/** `site` with its handler, which only `handlerOf` reads. */
export function withHandler<T extends object>(site: T, handler: unknown): T {
	handlers.set(site, handler)
	return site
}

/** The handler `.handle` attached to a site of the kit, or `undefined` for a site that took none. */
export function handlerOf(site: object): unknown {
	return handlers.get(site)
}

const snapshots = new WeakMap<object, Readonly<Record<string, ConnectSnapshot>>>()

/** `contract` with the snapshots of the kit's imports, by the import's name. */
export function withSnapshots<T extends object>(contract: T, imported: Readonly<Record<string, ConnectSnapshot>>): T {
	snapshots.set(contract, imported)
	return contract
}

/** The snapshots `app.contract` recorded for `contract`; none for a contract the kit did not build. */
export function snapshotsOf(contract: object): Readonly<Record<string, ConnectSnapshot>> {
	return snapshots.get(contract) ?? {}
}

/** Which kit built a contract: one with tables, `defineApp(vocabulary, tables)`, or one without, `defineApp(vocabulary)`. */
export type KitOrigin = 'tables' | 'tableless'

const origins = new WeakMap<object, KitOrigin>()

/** `contract` as `app.contract` built it, with the kind of kit that built it. */
export function withKitOrigin<T extends object>(contract: T, origin: KitOrigin): T {
	origins.set(contract, origin)
	return contract
}

/**
 * The kind of kit that built `contract`, or `undefined` for any other object, a copy of a kit's contract included: a
 * copy loses what is kept beside the original, so `serve` refuses it.
 */
export function kitOriginOf(contract: object): KitOrigin | undefined {
	return origins.get(contract)
}
