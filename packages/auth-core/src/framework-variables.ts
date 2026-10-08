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
	'FABRIKA_STORAGE_PROVENANCE',
	FABRIKA_PROXY_SECRET,
] as const

export type FrameworkVariableName = (typeof FRAMEWORK_VARIABLE_NAMES)[number]

const FRAMEWORK_VARIABLES: ReadonlySet<string> = new Set(FRAMEWORK_VARIABLE_NAMES)

/** Whether only the platform may write `name`. */
export function isFrameworkVariableName(name: string): name is FrameworkVariableName {
	return FRAMEWORK_VARIABLES.has(name)
}
