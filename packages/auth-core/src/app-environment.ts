/**
 * The IAM application id of one environment of an application: `<app>@<env>`, for example `notes@prod`
 * ([ADR-0022](../../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md) rule 6). Schemas,
 * roles, grants, keys and return origins are registered under it, so a staging key is refused at production.
 * The installation's own services keep a plain id without `@` — the platform audiences IAM registers.
 */

/** Separates the application from the environment. Reserved: neither part may contain it. */
export const APP_ENVIRONMENT_SEPARATOR = '@'

export interface AppEnvironment {
	readonly app: string
	readonly env: string
}

/** True when `value` can be one part of an application id: non-empty and without the separator. */
export function isAppEnvironmentPart(value: string): boolean {
	return value !== '' && !value.includes(APP_ENVIRONMENT_SEPARATOR)
}

/** Build `<app>@<env>`. Throws when either part is empty or contains `@`, because the id would not parse back. */
export function appEnvironmentId(app: string, env: string): string {
	if (!isAppEnvironmentPart(app) || !isAppEnvironmentPart(env)) {
		throw new Error(`an application id and an environment name must be non-empty and must not contain '${APP_ENVIRONMENT_SEPARATOR}'`)
	}
	return `${app}${APP_ENVIRONMENT_SEPARATOR}${env}`
}

/** The parts of `<app>@<env>`, or null for any other string — a platform audience or a malformed id. */
export function parseAppEnvironmentId(id: string): AppEnvironment | null {
	const parts = id.split(APP_ENVIRONMENT_SEPARATOR)
	if (parts.length !== 2) {
		return null
	}
	const [app = '', env = ''] = parts
	return isAppEnvironmentPart(app) && isAppEnvironmentPart(env) ? { app, env } : null
}
