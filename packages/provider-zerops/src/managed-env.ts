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
