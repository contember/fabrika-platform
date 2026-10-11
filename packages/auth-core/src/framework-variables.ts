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
	'FABRIKA_APP_RUNTIME_DATABASE_URL',
	'FABRIKA_APP_STORAGE_ENDPOINT',
	'FABRIKA_APP_STORAGE_BUCKET',
	'FABRIKA_APP_STORAGE_ACCESS_KEY_ID',
	'FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY',
	'FABRIKA_STORAGE_PROVENANCE',
	FABRIKA_PROXY_SECRET,
	'FABRIKA_IAM_RPC_URL',
	'FABRIKA_IAM_RPC_KEY',
] as const

export type FrameworkVariableName = (typeof FRAMEWORK_VARIABLE_NAMES)[number]

/**
 * The name families only the platform writes: one variable per job or webhook, named after it (`workloadKeyVariable`),
 * and a connector import's address, key and Worker binding (`connectVariables`). Every name under one is framework-only.
 */
export const FRAMEWORK_VARIABLE_PREFIXES = ['FABRIKA_JOB_', 'FABRIKA_WEBHOOK_', 'FABRIKA_CONNECT_'] as const

const FRAMEWORK_VARIABLES: ReadonlySet<string> = new Set(FRAMEWORK_VARIABLE_NAMES)

/** Whether only the platform may write `name`. */
export function isFrameworkVariableName(name: string): boolean {
	return FRAMEWORK_VARIABLES.has(name) || FRAMEWORK_VARIABLE_PREFIXES.some((prefix) => name.length > prefix.length && name.startsWith(prefix))
}

/** A contract name as one segment of a variable name: `nightlyDigest` → `NIGHTLY_DIGEST`. */
export function variableSegment(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

const WORKLOAD_KEY_VARIABLE = /^FABRIKA_(?:JOB|WEBHOOK)_[A-Z0-9][A-Z0-9_]*_KEY$/

/** Whether `name` is the variable of a job's or a webhook's credential, as `workloadKeyVariable` names one. */
export function isWorkloadKeyVariable(name: string): boolean {
	return WORKLOAD_KEY_VARIABLE.test(name)
}

/** The variable a job's or a webhook's credential travels under: `FABRIKA_JOB_NIGHTLY_DIGEST_KEY`. */
export function workloadKeyVariable(kind: 'job' | 'webhook', name: string): string {
	return `FABRIKA_${kind.toUpperCase()}_${variableSegment(name)}_KEY`
}

/** The variables that carry one connector import, and the Cloudflare service binding that carries its calls. */
export interface ConnectVariables {
	/** The owner's origin, `https://<owner host>`; on Cloudflare also the URL a binding request carries. */
	readonly url: string
	/** The consumer's `app` key at the owner. */
	readonly key: string
	/** The service binding to the owner's proxy Worker. */
	readonly binding: string
}

/** `catalog` → `FABRIKA_CONNECT_CATALOG_URL`, `_KEY` and the binding `FABRIKA_CONNECT_CATALOG`. */
export function connectVariables(importName: string): ConnectVariables {
	const binding = `FABRIKA_CONNECT_${variableSegment(importName)}`
	return { url: `${binding}_URL`, key: `${binding}_KEY`, binding }
}

const CONNECT_KEY_VARIABLE = /^FABRIKA_CONNECT_[A-Z0-9][A-Z0-9_]*_KEY$/
const CONNECT_URL_VARIABLE = /^FABRIKA_CONNECT_[A-Z0-9][A-Z0-9_]*_URL$/

/** Whether `name` carries a connector import's key, as `connectVariables` names it. */
export function isConnectKeyVariable(name: string): boolean {
	return CONNECT_KEY_VARIABLE.test(name)
}

/** Whether `name` carries a connector import's owner origin, as `connectVariables` names it. */
export function isConnectUrlVariable(name: string): boolean {
	return CONNECT_URL_VARIABLE.test(name)
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
