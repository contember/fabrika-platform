import { frameworkVariableReference, isFrameworkVariableName } from '@fabrika/auth-core'
import type { JsonValue } from '@fabrika/provider-contract'
import { renderYaml } from './compile'
import {
	assertOwnRunWhenExtending,
	executionZeropsDocument,
	parseZeropsDescriptor,
	type PreparedZeropsDescriptor,
	selectZeropsDescriptorSetup,
} from './descriptor'

const refuse = (): never => {
	throw new Error('zerops: application configuration uses a Fabrika-managed environment name')
}

/** Refuse every framework-only name (ADR-0043), not only the ones a deploy writes today. */
export function assertAuthoredManagedName(name: string): void {
	if (isFrameworkVariableName(name)) refuse()
}

/**
 * Names the runtime, its loader and its shells read to decide what a process runs, loads or sends its traffic through
 * (`BUN_OPTIONS=--eval=…` runs code from the value alone). An application secret becomes a variable of the service whose
 * init commands hold the provisioning credential, so whoever may manage the application's secrets would run code beside
 * it. `NODE_OPTIONS` is absent: the Bun runtime does not read it.
 */
const RUNTIME_NAMES: ReadonlySet<string> = new Set([
	'PATH',
	'HOME',
	'SHELL',
	'TMPDIR',
	'ENV',
	'BASH_ENV',
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'LD_AUDIT',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
])
const RUNTIME_PREFIXES: readonly string[] = ['BUN_', 'BASH_FUNC_']

/** The prefix Zerops keeps for its own variables; it refuses a custom one, so a stored service variable never has it. */
const ZEROPS_PREFIX = 'ZEROPS_'

/** Whether the runtime of an application service reads `name` itself. */
export function isRuntimeVariableName(name: string): boolean {
	return RUNTIME_NAMES.has(name) || RUNTIME_PREFIXES.some((prefix) => name.startsWith(prefix))
}

const runtimeNameRefusal = (name: string): Error =>
	new Error(
		`zerops: application secret \`${name}\` is read by the runtime to decide what its processes run; `
			+ "delete it with `fabrika control apps secrets delete` (add --env=<env> for one environment's), rename it if the code reads it, and deploy again",
	)

/**
 * Refuse a name an application secret may not take on Zerops: a framework-only one, one the runtime reads, or one in
 * Zerops' own prefix. Deleting a secret checks only the first, so a secret stored before a name joined the others stays
 * removable. An application variable needs no such rule: on Zerops it only fills a placeholder the repository declared.
 */
export function assertApplicationSecretName(name: string): void {
	assertAuthoredManagedName(name)
	if (isRuntimeVariableName(name) || name.startsWith(ZEROPS_PREFIX)) throw runtimeNameRefusal(name)
}

/** Refuse a deploy to a service that already holds a secret the runtime reads, e.g. one stored before the rule. */
export function assertNoStoredRuntimeVariable(keys: readonly string[]): void {
	const stored = keys.find(isRuntimeVariableName)
	if (stored !== undefined) throw runtimeNameRefusal(stored)
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
	assertOwnRunWhenExtending(parsed, selected)
	const execution = executionZeropsDocument(parsed, selected)
	const entries = execution['zerops']
	if (!Array.isArray(entries)) throw new Error('zerops: descriptor requires setup entries')
	const overlaid = release === null ? entries : entries.map((entry) => {
		if (!isMapping(entry) || entry['setup'] !== selected) return entry
		const run = isMapping(entry['run']) ? entry['run'] : {}
		const env = isMapping(run['envVariables']) ? run['envVariables'] : {}
		return { ...entry, run: { ...run, envVariables: { ...env, FABRIKA_RELEASE: release } } }
	})
	return { contents: renderYaml({ ...execution, zerops: overlaid }), setup: selected }
}
