import { FABRIKA_IAM_APP_ID } from './app-environment'
import { FABRIKA_CONTRACT_DIGEST } from './endpoint-digest'
import { FABRIKA_IAM_ISSUER } from './environment'
import { FABRIKA_PROXY_SECRET } from './wire'

/**
 * The environment names only the platform writes into an application
 * ([ADR-0043](../../../docs/decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md)). Control refuses an
 * application variable or secret under one of them, and so does every provider, for every surface that writes one.
 * A work unit that gives an application a new credential adds its name here.
 */
export const FRAMEWORK_VARIABLE_NAMES = [
	'FABRIKA_RELEASE',
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_ISSUER,
	FABRIKA_IAM_APP_ID,
	'FABRIKA_OPERATIONS_DSN',
	'FABRIKA_APP_ID',
	'FABRIKA_ENVIRONMENT',
	'FABRIKA_SERVICE_KEY',
	'FABRIKA_APP_DATABASE_URL',
	'FABRIKA_APP_STORAGE_ENDPOINT',
	'FABRIKA_APP_STORAGE_BUCKET',
	'FABRIKA_APP_STORAGE_ACCESS_KEY_ID',
	'FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY',
	'FABRIKA_STORAGE_PROVENANCE',
	FABRIKA_PROXY_SECRET,
] as const

export type FrameworkVariableName = (typeof FRAMEWORK_VARIABLE_NAMES)[number]

const FRAMEWORK_VARIABLES: ReadonlySet<string> = new Set(FRAMEWORK_VARIABLE_NAMES)

/** Whether only the platform may write `name`. */
export function isFrameworkVariableName(name: string): name is FrameworkVariableName {
	return FRAMEWORK_VARIABLES.has(name)
}

/** A Zerops reference: `${NAME}`, `${RUNTIME_NAME}`, `${<host>_NAME}` or `${RUNTIME_<host>_NAME}`. */
const REFERENCE = /\$\{([^}]*)\}?/g
const RUNTIME_PREFIX = /^RUNTIME_/
const HOST_PREFIX = /^[a-z0-9]{1,25}_/

/**
 * The first reference in `text` to a framework-only variable, or `null`. A value that references one copies a
 * platform credential into a variable the application controls, so every surface that writes authored values refuses
 * it. A reference nested in another is refused too, because its name is only known once Zerops resolves it.
 */
export function frameworkVariableReference(text: string): string | null {
	for (const match of text.matchAll(REFERENCE)) {
		const inner = match[1] ?? ''
		if (inner.includes('${')) return match[0]
		const local = inner.replace(RUNTIME_PREFIX, '')
		for (const name of [inner, local, local.replace(HOST_PREFIX, '')]) {
			if (isFrameworkVariableName(name)) return match[0]
		}
	}
	return null
}
