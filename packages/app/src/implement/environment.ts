// The framework's variables, taken out of the process before any application module loads. A module that copies the
// environment while it initialises then copies an environment without them.

import type { ApplicationEnvironment } from './implement'

/** Every variable under this prefix is the framework's; no application code sees one. */
export const FRAMEWORK_PREFIX = 'FABRIKA_'

/**
 * The container credentials endpoint's variables, which ECS writes into every container: the path holds the task's id,
 * and whoever reads it fetches the task role's credentials, which sign for the application's stored files. They are the
 * framework's too, so a dependency that copies `process.env` never copies them (`FABRIKA_APP_STORAGE_CREDENTIALS`).
 * Like every captured variable they stay in the process's initial environment, `/proc/self/environ` on Linux, which
 * code in the same process can still read (backlog 301).
 */
export const CONTAINER_CREDENTIAL_VARIABLES: readonly string[] = Object.freeze([
	'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
	'AWS_CONTAINER_CREDENTIALS_FULL_URI',
	'AWS_CONTAINER_AUTHORIZATION_TOKEN',
	'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
])

/** Whether `name` is one the framework captures and takes out of the process. */
const isFrameworkOwned = (name: string): boolean => name.startsWith(FRAMEWORK_PREFIX) || CONTAINER_CREDENTIAL_VARIABLES.includes(name)

export interface CapturedEnvironment {
	/** The `FABRIKA_*` variables and the container credentials endpoint's, for `boot` only. */
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
			if (isFrameworkOwned(name)) {
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
		if (!isFrameworkOwned(name)) {
			Object.defineProperty(application, name, { value, enumerable: true })
		} else if (typeof value === 'string') {
			Object.defineProperty(framework, name, { value, enumerable: true })
		}
	}
	scrubProcessEnvironment()
	return Object.freeze({ framework: Object.freeze(framework), application: Object.freeze(application) })
}
