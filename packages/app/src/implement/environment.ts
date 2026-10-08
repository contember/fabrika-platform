// The framework's variables, taken out of the process before any application module loads. A module that copies the
// environment while it initialises then copies an environment without them.

import type { ApplicationEnvironment } from './implement'

/** Every variable under this prefix is the framework's; no application code sees one. */
export const FRAMEWORK_PREFIX = 'FABRIKA_'

export interface CapturedEnvironment {
	/** The `FABRIKA_*` variables, for `boot` only. */
	readonly framework: Readonly<Record<string, string>>
	/** Every other variable or binding, for the application's `deps`. */
	readonly application: ApplicationEnvironment
}

/** Deletes every framework variable from `process.env` and `Bun.env`. */
function scrubProcessEnvironment(): void {
	const environments = [typeof process === 'undefined' ? undefined : process.env, typeof Bun === 'undefined' ? undefined : Bun.env]
	for (const environment of environments) {
		if (environment === undefined) {
			continue
		}
		for (const name of Object.keys(environment)) {
			if (name.startsWith(FRAMEWORK_PREFIX)) {
				delete environment[name]
			}
		}
	}
}

/**
 * Splits `source` into the framework's variables and the application's, then scrubs the process environment.
 * The generated entrypoint calls it through its runtime adapter before it imports `src/app.ts`.
 */
export function captureEnvironment(source: Readonly<Record<string, unknown>>): CapturedEnvironment {
	const framework: Record<string, string> = {}
	const application: Record<string, unknown> = {}
	for (const [name, value] of Object.entries(source)) {
		if (!name.startsWith(FRAMEWORK_PREFIX)) {
			Object.defineProperty(application, name, { value, enumerable: true })
		} else if (typeof value === 'string') {
			Object.defineProperty(framework, name, { value, enumerable: true })
		}
	}
	scrubProcessEnvironment()
	return Object.freeze({ framework: Object.freeze(framework), application: Object.freeze(application) })
}
