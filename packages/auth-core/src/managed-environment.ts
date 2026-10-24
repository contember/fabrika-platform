import { FABRIKA_IAM_APP_ID } from './app-environment'
import { FABRIKA_CONTRACT_DIGEST } from './endpoint-digest'
import { FABRIKA_IAM_ISSUER } from './environment'
import {
	FABRIKA_APP_ORIGIN,
	FABRIKA_OPS_KEY_DIGESTS,
	FABRIKA_TOKEN_KEYS,
	FRAMEWORK_VARIABLE_PREFIXES,
	type FrameworkVariableName,
	isConnectKeyVariable,
	isConnectUrlVariable,
	isEmailTransportVariable,
	isPlatformTransportVariable,
	isWorkloadKeyVariable,
	PLATFORM_RECEIVERS,
	platformTransportVariables,
} from './framework-variables'
import { FABRIKA_PROXY_SECRET } from './wire'

/**
 * The framework names Control hands every deploy, each with a value or `null` (the deploy removes it). Beside them, a
 * deploy carries the families of `FRAMEWORK_VARIABLE_PREFIXES`, one variable per workload, import or receiver.
 */
export const MANAGED_VARIABLE_NAMES = [
	'FABRIKA_RELEASE',
	'FABRIKA_OPERATIONS_DSN',
	FABRIKA_IAM_ISSUER,
	FABRIKA_IAM_APP_ID,
	'FABRIKA_APP_ID',
	'FABRIKA_ENVIRONMENT',
	'FABRIKA_SERVICE_KEY',
	FABRIKA_PROXY_SECRET,
	'FABRIKA_IAM_RPC_URL',
	'FABRIKA_IAM_RPC_KEY',
	FABRIKA_APP_ORIGIN,
	FABRIKA_TOKEN_KEYS,
	FABRIKA_OPS_KEY_DIGESTS,
] as const satisfies readonly FrameworkVariableName[]

export type ManagedVariableName = (typeof MANAGED_VARIABLE_NAMES)[number]

const MANAGED_VARIABLES: ReadonlySet<string> = new Set(MANAGED_VARIABLE_NAMES)

/** The framework names that carry no credential: identities, origins and the release. */
const PUBLIC_VARIABLES: ReadonlySet<string> = new Set<FrameworkVariableName>([
	'FABRIKA_RELEASE',
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_ISSUER,
	FABRIKA_IAM_APP_ID,
	'FABRIKA_APP_ID',
	'FABRIKA_ENVIRONMENT',
	'FABRIKA_IAM_RPC_URL',
	FABRIKA_APP_ORIGIN,
	// SHA-256 of 256-bit random keys: a digest neither is a key nor lets anyone forge one.
	FABRIKA_OPS_KEY_DIGESTS,
])

const PLATFORM_URL_VARIABLES: ReadonlySet<string> = new Set(PLATFORM_RECEIVERS.map((receiver) => platformTransportVariables(receiver).url))

/**
 * Whether a managed variable carries a credential, so a provider writes it as a secret and never reads it back. Fail
 * closed: a name not known to be public is a credential.
 */
export function isManagedCredential(name: string): boolean {
	return !PUBLIC_VARIABLES.has(name) && !isConnectUrlVariable(name) && !PLATFORM_URL_VARIABLES.has(name)
}

/** Whether a deploy writes `name` from what Control hands it, so a deploy that no longer hands it removes it. */
export function isManagedVariableName(name: string): boolean {
	return MANAGED_VARIABLES.has(name) || FRAMEWORK_VARIABLE_PREFIXES.some((prefix) => name.length > prefix.length && name.startsWith(prefix))
}

/** One managed variable: its value, or `null` when the deploy removes it, and whether it is a credential. */
export interface ManagedEntry {
	readonly value: string | null
	readonly credential: boolean
}

/** What Control hands a deploy, parsed once: every name is one Control writes, and every family value has its shape. */
export type ManagedEnvironment = Readonly<Record<string, ManagedEntry>>

const isOrigin = (value: string, schemes: readonly string[]): boolean => {
	try {
		const url = new URL(value)
		return url.origin === value && schemes.includes(url.protocol)
	} catch {
		return false
	}
}

const KEY = /^px_./s

const isKey = (value: string | null): boolean => value !== null && KEY.test(value)

/** The reason a family variable's value is refused, or `null`. Messages name the variable, never its value. */
const familyProblem = (name: string, value: string | null): string | null => {
	if (isEmailTransportVariable(name)) return value === null || value === '' ? 'must not be empty' : null
	if (PLATFORM_URL_VARIABLES.has(name)) {
		// Control's public origin is http in the local stack (`http://control.fabrika.localhost:18080`).
		return value !== null && isOrigin(value, ['http:', 'https:']) ? null : 'must be an http(s) origin'
	}
	if (isConnectUrlVariable(name)) return value !== null && isOrigin(value, ['https:']) ? null : 'must be an https origin'
	if (isPlatformTransportVariable(name) || isWorkloadKeyVariable(name) || isConnectKeyVariable(name)) {
		return isKey(value) ? null : 'must be a px_ key'
	}
	return 'is not a variable a deploy writes'
}

/**
 * Parse what Control hands a deploy. Control parses it before any provider effect, and the Cloudflare executor parses
 * what its job carries; a name or a value Control would not produce fails either.
 */
export function parseManagedEnvironment(value: Readonly<Record<string, string | null>>): ManagedEnvironment {
	const parsed: Record<string, ManagedEntry> = {}
	for (const [name, entry] of Object.entries(value)) {
		if (!MANAGED_VARIABLES.has(name)) {
			const problem = familyProblem(name, entry)
			if (problem !== null) throw new Error(`managed environment: ${name} ${problem}`)
		}
		parsed[name] = { value: entry, credential: isManagedCredential(name) }
	}
	return parsed
}

/** The value a deploy writes under `name`, or `null` when it writes none. */
export function managedValue(environment: ManagedEnvironment, name: string): string | null {
	return environment[name]?.value ?? null
}

/**
 * The managed variables a service or Worker still holds that the deploy no longer writes: handed as `null`, or a
 * family member no longer handed. `written` names what the deploy writes there.
 */
export function staleManagedVariables(present: Iterable<string>, written: ReadonlySet<string>): string[] {
	return [...present].filter((name) => isManagedVariableName(name) && !written.has(name))
}
