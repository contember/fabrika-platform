// @fabrika/db/production — whether this process serves an application. The generated entrypoint marks it before it
// imports the application, and the test kits refuse to load or run once it is marked. The mark is one non-writable,
// non-configurable property of `globalThis` under a registered symbol, so every installed copy of this package reads
// the same mark, it survives the scrub of the framework's variables (`FABRIKA_RELEASE` included), and nothing unmarks
// it. Browser- and Worker-safe.

const PRODUCTION = Symbol.for('fabrika.production')

/** Marks this process as one that serves an application; called by the generated entrypoint only. */
export function markProductionProcess(): void {
	if (isProductionProcess()) {
		return
	}
	Object.defineProperty(globalThis, PRODUCTION, { value: true, writable: false, configurable: false, enumerable: false })
}

export function isProductionProcess(): boolean {
	return Reflect.get(globalThis, PRODUCTION) === true
}

/** Throws when this process serves an application: `what` is a test helper, which production never runs. */
export function refuseInProduction(what: string): void {
	if (isProductionProcess()) {
		throw new Error(`${what} is a test helper; this process serves an application, so it neither loads nor runs here`)
	}
}
