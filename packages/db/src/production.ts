// @fabrika/db/production — whether this process serves an application. The generated entrypoint marks it before it
// imports the application, and the test kits refuse to load or run once it is marked. The mark survives the scrub of
// the framework's variables (`FABRIKA_RELEASE` included), and nothing unmarks it. Browser- and Worker-safe.

let serving = false

/** Marks this process as one that serves an application; called by the generated entrypoint only. */
export function markProductionProcess(): void {
	serving = true
}

export function isProductionProcess(): boolean {
	return serving
}

/** Throws when this process serves an application: `what` is a test helper, which production never runs. */
export function refuseInProduction(what: string): void {
	if (serving) {
		throw new Error(`${what} is a test helper; this process serves an application, so it neither loads nor runs here`)
	}
}
