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

const tableless = new WeakSet<object>()

/** `contract` as built by a kit without tables, `defineApp(vocabulary)`. */
export function withoutTables<T extends object>(contract: T): T {
	tableless.add(contract)
	return contract
}

/** Whether a kit without tables built `contract`: its sites are served without `ctx.db`, and `serve` takes no database. */
export function isTableless(contract: object): boolean {
	return tableless.has(contract)
}
