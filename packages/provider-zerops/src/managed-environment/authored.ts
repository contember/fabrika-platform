import { MANAGED_ENVIRONMENT_PREFIX, MANAGED_KEYS } from './protocol'

type AuthoredDocumentValue = string | number | boolean | null | readonly AuthoredDocumentValue[] | { readonly [key: string]: AuthoredDocumentValue }
const isSequence = (value: AuthoredDocumentValue): value is readonly AuthoredDocumentValue[] => Array.isArray(value)

const refuse = (): never => {
	throw new Error('zerops: application configuration uses a managed-environment name or reference')
}

export function assertAuthoredManagedName(name: string): void {
	if (name.startsWith(MANAGED_ENVIRONMENT_PREFIX) || MANAGED_KEYS.some((key) => key === name)) refuse()
	assertNoManagedReferences(name)
}

export function assertNoManagedReferences(value: string): void {
	for (const match of value.matchAll(/\$\{([^{}]+)\}/g)) {
		const name = match[1]
		if (name !== undefined && /^(?:RUNTIME_)?(?:[a-z0-9]{1,25}_)?FABRIKA_MENV_/.test(name)) refuse()
	}
}

/** Apply to the parsed descriptor/import and again to the fully substituted import document. */
export function assertAuthoredManagedDocument(value: AuthoredDocumentValue): void {
	const visit = (entry: AuthoredDocumentValue, environmentMapping: boolean): void => {
		if (typeof entry === 'string') {
			assertNoManagedReferences(entry)
			return
		}
		if (isSequence(entry)) {
			for (const item of entry) visit(item, false)
			return
		}
		if (typeof entry !== 'object' || entry === null) return
		for (const [key, item] of Object.entries(entry)) {
			if (key.startsWith(MANAGED_ENVIRONMENT_PREFIX)) refuse()
			assertNoManagedReferences(key)
			if (environmentMapping) assertAuthoredManagedName(key)
			visit(item, key === 'envVariables' || key === 'envSecrets')
		}
	}
	visit(value, false)
}

export function assertAuthoredManagedInputs(input: {
	variableNames: readonly string[]
	secretNames: readonly string[]
	variableValues?: Readonly<Record<string, string>>
	secretValues?: Readonly<Record<string, string>>
}): void {
	for (const name of [...input.variableNames, ...input.secretNames]) assertAuthoredManagedName(name)
	for (const values of [input.variableValues, input.secretValues]) {
		if (values === undefined) continue
		for (const [name, value] of Object.entries(values)) {
			assertAuthoredManagedName(name)
			assertNoManagedReferences(value)
		}
	}
}
