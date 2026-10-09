import {
	FRAMEWORK_VARIABLE_PREFIXES,
	type FrameworkVariableName,
	frameworkVariableReference,
	isFrameworkVariableName,
	isWorkloadKeyVariable,
} from '@fabrika/auth-core'
import type { JsonValue } from '@fabrika/provider-contract'
import { z } from 'zod'
import { renderYaml } from './compile'
import { parseZeropsDescriptor, type PreparedZeropsDescriptor, selectZeropsDescriptorSetup } from './descriptor'

/** The framework-only names Control hands every Zerops deploy; the rest of the list is the provider's own. */
export type ManagedKey = Extract<
	FrameworkVariableName,
	| 'FABRIKA_RELEASE'
	| 'FABRIKA_OPERATIONS_DSN'
	| 'FABRIKA_IAM_ISSUER'
	| 'FABRIKA_IAM_APP_ID'
	| 'FABRIKA_APP_ID'
	| 'FABRIKA_ENVIRONMENT'
	| 'FABRIKA_SERVICE_KEY'
	| 'FABRIKA_PROXY_SECRET'
	| 'FABRIKA_IAM_RPC_URL'
	| 'FABRIKA_IAM_RPC_KEY'
>

export const MANAGED_KEYS: readonly ManagedKey[] = [
	'FABRIKA_RELEASE',
	'FABRIKA_OPERATIONS_DSN',
	'FABRIKA_IAM_ISSUER',
	'FABRIKA_IAM_APP_ID',
	'FABRIKA_APP_ID',
	'FABRIKA_ENVIRONMENT',
	'FABRIKA_SERVICE_KEY',
	'FABRIKA_PROXY_SECRET',
	'FABRIKA_IAM_RPC_URL',
	'FABRIKA_IAM_RPC_KEY',
]

/** The managed keys written as service variables; `FABRIKA_RELEASE` travels only in the execution descriptor (ADR-0044). */
export const SERVICE_MANAGED_KEYS: readonly Exclude<ManagedKey, 'FABRIKA_RELEASE'>[] = [
	'FABRIKA_OPERATIONS_DSN',
	'FABRIKA_IAM_ISSUER',
	'FABRIKA_IAM_APP_ID',
	'FABRIKA_APP_ID',
	'FABRIKA_ENVIRONMENT',
	'FABRIKA_SERVICE_KEY',
	'FABRIKA_PROXY_SECRET',
	'FABRIKA_IAM_RPC_URL',
	'FABRIKA_IAM_RPC_KEY',
]

export type ManagedValues = Record<ManagedKey, string | null>

const managedValuesSchema = z.object({
	FABRIKA_RELEASE: z.string().nullable(),
	FABRIKA_OPERATIONS_DSN: z.string().nullable(),
	FABRIKA_IAM_ISSUER: z.string().nullable(),
	FABRIKA_IAM_APP_ID: z.string().nullable(),
	FABRIKA_APP_ID: z.string().nullable(),
	FABRIKA_ENVIRONMENT: z.string().nullable(),
	FABRIKA_SERVICE_KEY: z.string().nullable(),
	FABRIKA_PROXY_SECRET: z.string().nullable(),
	// IAM's membership transport (ADR-0022 rule 6): its public origin and this environment's key, or both null.
	FABRIKA_IAM_RPC_URL: z.string().nullable(),
	FABRIKA_IAM_RPC_KEY: z.string().nullable(),
}).strict()

export function parseManagedValues(value: unknown): ManagedValues {
	const result = managedValuesSchema.safeParse(value)
	if (!result.success) throw new Error('zerops: managed environment must name exactly the ten managed keys')
	return result.data
}

/** What Control hands a deploy: the ten managed keys, and the key of each job and webhook of the approved contract. */
export interface ManagedEnvironment {
	readonly values: ManagedValues
	/** `FABRIKA_<KIND>_<NAME>_KEY` → the workload's `px_` key. */
	readonly workloadKeys: Readonly<Record<string, string>>
}

const workloadKeySchema = z.string().startsWith('px_').min(4)

export function parseManagedEnvironment(value: Readonly<Record<string, string | null>>): ManagedEnvironment {
	const managed: Record<string, string | null> = {}
	const workloadKeys: Record<string, string> = {}
	for (const [name, entry] of Object.entries(value)) {
		if (!isWorkloadKeyVariable(name)) {
			managed[name] = entry
			continue
		}
		const key = workloadKeySchema.safeParse(entry)
		if (!key.success) throw new Error(`zerops: ${name} must be a px_ key`)
		workloadKeys[name] = key.data
	}
	return { values: parseManagedValues(managed), workloadKeys }
}

/** A service variable only the platform writes per workload: a stale one is removed with its workload. */
export function isFrameworkFamilyVariable(name: string): boolean {
	return FRAMEWORK_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

const refuse = (): never => {
	throw new Error('zerops: application configuration uses a Fabrika-managed environment name')
}

/** Refuse every framework-only name (ADR-0043), not only the ones a deploy writes today. */
export function assertAuthoredManagedName(name: string): void {
	if (isFrameworkVariableName(name)) refuse()
}

type AuthoredDocumentValue = string | number | boolean | null | readonly AuthoredDocumentValue[] | { readonly [key: string]: AuthoredDocumentValue }
const isSequence = (value: AuthoredDocumentValue): value is readonly AuthoredDocumentValue[] => Array.isArray(value)

/** Refuse a value that references a framework-only variable (`${RUNTIME_FABRIKA_PROXY_SECRET}`), naming only the reference. */
export function assertNoFrameworkReference(text: string): void {
	const reference = frameworkVariableReference(text)
	if (reference !== null) {
		throw new Error(`zerops: application configuration references the Fabrika-managed variable \`${reference}\``)
	}
}

/**
 * Refuse, in any `envVariables`/`envSecrets` mapping at any depth, a managed name as a key and a reference to one in a
 * key or a value: Zerops resolves the reference into a variable the application controls, and lifts it into a build.
 */
export function assertAuthoredManagedDocument(value: AuthoredDocumentValue): void {
	const visit = (entry: AuthoredDocumentValue, environmentMapping: boolean): void => {
		if (isSequence(entry)) {
			for (const item of entry) visit(item, false)
			return
		}
		if (typeof entry !== 'object' || entry === null) return
		for (const [key, item] of Object.entries(entry)) {
			if (environmentMapping) {
				assertAuthoredManagedName(key)
				assertNoFrameworkReference(key)
				if (typeof item === 'string') assertNoFrameworkReference(item)
			}
			visit(item, key === 'envVariables' || key === 'envSecrets')
		}
	}
	visit(value, false)
}

export function assertAuthoredManagedInputs(input: { variableNames: readonly string[]; secretNames: readonly string[] }): void {
	for (const name of [...input.variableNames, ...input.secretNames]) assertAuthoredManagedName(name)
}

const isMapping = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Render the execution descriptor: the source descriptor with `FABRIKA_RELEASE` written as a literal into
 * the selected setup's `run.envVariables`, so the release travels with the version (ADR-0044). A null
 * release omits the key. The source descriptor's bytes and digest are untouched.
 */
export function overlayRelease(contents: string, setup: string | undefined, release: string | null): PreparedZeropsDescriptor {
	// Zerops resolves `${…}` in run variables, so a release carrying one would read another variable.
	if (release?.includes('${') === true) throw new Error('zerops: a release name must not contain `${`')
	const parsed = parseZeropsDescriptor(contents)
	assertAuthoredManagedDocument(parsed.document)
	const selected = selectZeropsDescriptorSetup(parsed, setup)
	const entries = parsed.document['zerops']
	if (!Array.isArray(entries)) throw new Error('zerops: descriptor requires setup entries')
	const overlaid = release === null ? entries : entries.map((entry) => {
		if (!isMapping(entry) || entry['setup'] !== selected) return entry
		const run = isMapping(entry['run']) ? entry['run'] : {}
		const env = isMapping(run['envVariables']) ? run['envVariables'] : {}
		return { ...entry, run: { ...run, envVariables: { ...env, FABRIKA_RELEASE: release } } }
	})
	return { contents: renderYaml({ ...parsed.document, zerops: overlaid }), setup: selected }
}
