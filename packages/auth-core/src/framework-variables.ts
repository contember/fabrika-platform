import { FABRIKA_IAM_APP_ID } from './app-environment'
import { FABRIKA_CONTRACT_DIGEST } from './endpoint-digest'
import { FABRIKA_IAM_ISSUER } from './environment'
import { sha256Hex } from './sha256'
import type { WorkloadKind } from './types'
import { FABRIKA_PROXY_SECRET } from './wire'

/** Where a platform build uploads its source maps: the destination without its bearer, and the asset roots (JSON). */
export const FABRIKA_SOURCE_MAP_UPLOAD = 'FABRIKA_SOURCE_MAP_UPLOAD'
/** The run-scoped bearer of that upload. */
export const FABRIKA_SOURCE_MAP_UPLOAD_KEY = 'FABRIKA_SOURCE_MAP_UPLOAD_KEY'
/**
 * The keys an application environment signs and verifies its signed tokens with: `<kid>:<secret>` entries joined by `,`,
 * the signing key first, then each retired key still verifying. Written only for a contract that declares token purposes.
 */
export const FABRIKA_TOKEN_KEYS = 'FABRIKA_TOKEN_KEYS'
/** The environment's canonical origin (`https://crm.example`), which `ctx.url` builds absolute links on. */
export const FABRIKA_APP_ORIGIN = 'FABRIKA_APP_ORIGIN'
/** The digests of the environment's ops keys, which the object checks Control's key against (`parseOpsKeyDigests`, ADR-0069). */
export const FABRIKA_OPS_KEY_DIGESTS = 'FABRIKA_OPS_KEY_DIGESTS'
/** The name of the object that serves an environment's ordinary traffic on Cloudflare; `application` without it. */
export const FABRIKA_APPLICATION_OBJECT = 'FABRIKA_APPLICATION_OBJECT'
/** The object names an ops request may target, all in the environment's own namespace. */
export const FABRIKA_APPLICATION_OBJECTS = 'FABRIKA_APPLICATION_OBJECTS'

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
	'FABRIKA_APP_DATABASE_CONNECTIONS',
	'FABRIKA_APP_STORAGE_ENDPOINT',
	'FABRIKA_APP_STORAGE_BUCKET',
	'FABRIKA_APP_STORAGE_ACCESS_KEY_ID',
	'FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY',
	'FABRIKA_STORAGE_PROVENANCE',
	FABRIKA_PROXY_SECRET,
	'FABRIKA_IAM_RPC_URL',
	'FABRIKA_IAM_RPC_KEY',
	FABRIKA_SOURCE_MAP_UPLOAD,
	FABRIKA_SOURCE_MAP_UPLOAD_KEY,
	FABRIKA_TOKEN_KEYS,
	FABRIKA_APP_ORIGIN,
	FABRIKA_OPS_KEY_DIGESTS,
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
] as const

export type FrameworkVariableName = (typeof FRAMEWORK_VARIABLE_NAMES)[number]

/**
 * The name families only the platform writes: one variable per job, webhook or public procedure, named after it
 * (`workloadKeyVariable`), a connector import's address, key and Worker binding (`connectVariables`), the
 * installation's mail transport (`isEmailTransportVariable`), and a platform receiver's address and key
 * (`platformTransportVariables`). Every name under one is framework-only. A public procedure's family is
 * `FABRIKA_PROCEDURE_`, because `FABRIKA_PUBLIC_*` names an application's public build values.
 */
export const FRAMEWORK_VARIABLE_PREFIXES = [
	'FABRIKA_JOB_',
	'FABRIKA_WEBHOOK_',
	'FABRIKA_PROCEDURE_',
	'FABRIKA_CONNECT_',
	'FABRIKA_EMAIL_',
	'FABRIKA_PLATFORM_',
] as const

const FRAMEWORK_VARIABLES: ReadonlySet<string> = new Set(FRAMEWORK_VARIABLE_NAMES)

/** Whether only the platform may write `name`. */
export function isFrameworkVariableName(name: string): boolean {
	return FRAMEWORK_VARIABLES.has(name) || FRAMEWORK_VARIABLE_PREFIXES.some((prefix) => name.length > prefix.length && name.startsWith(prefix))
}

/** A contract name as one segment of a variable name: `nightlyDigest` → `NIGHTLY_DIGEST`. */
export function variableSegment(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

const WORKLOAD_KEY_VARIABLE = /^FABRIKA_(?:JOB|WEBHOOK|PROCEDURE)_[A-Z0-9][A-Z0-9_]*_KEY$/

/** Whether `name` is the variable of a job's, a webhook's or a public procedure's credential, as `workloadKeyVariable` names one. */
export function isWorkloadKeyVariable(name: string): boolean {
	return WORKLOAD_KEY_VARIABLE.test(name)
}

/** The workload kinds an application holds its own key of; an `app` key is a connector's (`connectVariables`). */
export type OwnWorkloadKind = Exclude<WorkloadKind, 'app'>

/**
 * The variable a workload's credential travels under: `FABRIKA_JOB_NIGHTLY_DIGEST_KEY`. A public procedure's endpoint id
 * has dots and may differ from another only by case or `_`, so its readable segment carries the first 8 hex digits of
 * the id's SHA-256 as well: `api.stats.cta` → `FABRIKA_PROCEDURE_API_STATS_CTA_<8 hex>_KEY`.
 */
export function workloadKeyVariable(kind: OwnWorkloadKind, name: string): string {
	if (kind === 'public') {
		return `FABRIKA_PROCEDURE_${variableSegment(name.replaceAll('.', '_'))}_${sha256Hex(name).slice(0, 8).toUpperCase()}_KEY`
	}
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

const EMAIL_VARIABLE = /^FABRIKA_EMAIL_[A-Z0-9][A-Z0-9_]*$/

/** Whether `name` belongs to the installation's mail transport, which only Control hands an application. */
export function isEmailTransportVariable(name: string): boolean {
	return EMAIL_VARIABLE.test(name)
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

/**
 * The platform's receivers an application reaches over the platform transport: `mail`, the relay of its jobs' mail, and
 * `source`, which hands the launcher of a `dev` environment the files of the workspace bound to it (ADR-0064).
 */
export const PLATFORM_RECEIVERS = ['mail', 'source'] as const

export type PlatformReceiver = (typeof PLATFORM_RECEIVERS)[number]

/** The variables that carry one platform receiver: its base URL, which is public, and the application's key, which is secret. */
export interface PlatformTransportVariables {
	readonly url: string
	readonly key: string
}

/** `mail` → `FABRIKA_PLATFORM_MAIL_URL` and `FABRIKA_PLATFORM_MAIL_KEY`. */
export function platformTransportVariables(receiver: PlatformReceiver): PlatformTransportVariables {
	const prefix = `FABRIKA_PLATFORM_${variableSegment(receiver)}`
	return { url: `${prefix}_URL`, key: `${prefix}_KEY` }
}

const PLATFORM_TRANSPORT_VARIABLES: ReadonlySet<string> = new Set(
	PLATFORM_RECEIVERS.flatMap((receiver) => Object.values(platformTransportVariables(receiver))),
)

/** Whether `name` carries a platform receiver's URL or key, as `platformTransportVariables` names them. */
export function isPlatformTransportVariable(name: string): boolean {
	return PLATFORM_TRANSPORT_VARIABLES.has(name)
}
