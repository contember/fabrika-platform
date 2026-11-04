// `fabrika app build` refuses an application configuration that writes a credential where everyone can read it.
//
// Every `envVariables` value a Zerops application authors (in any setup of its `zerops.yaml`; the compiled import of
// `fabrika.config.ts` is checked the same way, though its types offer none today) becomes a READABLE service variable,
// read by every member of the project, and sits in the repository in clear. A `run.routing.headers` value is sent to every visitor. A credential belongs in `pipeline.secrets`, set with
// `fabrika control apps secrets put`, which Zerops stores sensitive. The check runs at build only, never when a stored
// manifest is decoded: an application meets it when it raises its own pin, as with any framework API change.
//
// The heuristic errs towards refusing, so `target.notSecret` names the variables and headers the author has checked.

import type { JsonValue } from '@fabrika/provider-contract'
import { plainCredentialFinding } from '@fabrika/provider-contract'

/** One authored value that looks like a credential: where it is, and why. Never the value. */
interface AuthoredPlainCredential {
	readonly path: string
	readonly name: string
	readonly because: string
	readonly header: boolean
}

const isMapping = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every `envVariables` entry and every `routing.headers[].values` entry of a document, at any depth. */
const authoredPlainCredentials = (document: JsonValue, root: string, notSecret: ReadonlySet<string>): AuthoredPlainCredential[] => {
	const found: AuthoredPlainCredential[] = []
	const check = (path: string, name: string, value: JsonValue, header: boolean): void => {
		if (typeof value !== 'string' || notSecret.has(name)) return
		const finding = plainCredentialFinding(name, value)
		if (finding !== null) found.push({ path, name, because: finding.because, header })
	}
	const visit = (value: JsonValue, path: string): void => {
		if (Array.isArray(value)) {
			value.forEach((item, index) => visit(item, `${path}[${index}]`))
			return
		}
		if (!isMapping(value)) return
		for (const [key, item] of Object.entries(value)) {
			const at = `${path}.${key}`
			if (key === 'envVariables' && isMapping(item)) {
				for (const [name, text] of Object.entries(item)) check(`${at}.${name}`, name, text, false)
				continue
			}
			if (key === 'routing' && isMapping(item) && Array.isArray(item['headers'])) {
				item['headers'].forEach((rule, index) => {
					const values = isMapping(rule) ? rule['values'] : undefined
					if (!isMapping(values)) return
					for (const [name, text] of Object.entries(values)) check(`${at}.headers[${index}].values.${name}`, name, text, true)
				})
			}
			visit(item, at)
		}
	}
	visit(document, root)
	return found
}

/**
 * Refuse every authored plain value that looks like a credential, naming each by its path and reason, never by value.
 *
 * `importDocument` is the compiled import of `fabrika.config.ts`; `descriptor` the parsed `zerops.yaml`, every setup.
 */
export function assertNoAuthoredPlainCredential(
	importDocument: JsonValue,
	descriptor: JsonValue,
	notSecret: readonly string[],
): void {
	const allowed = new Set(notSecret)
	const found = [
		...authoredPlainCredentials(importDocument, 'fabrika.config.ts', allowed),
		...authoredPlainCredentials(descriptor, 'zerops.yaml', allowed),
	]
	if (found.length === 0) return
	const lines = found.map((entry) => `  ${entry.path}: ${entry.because}`)
	const remedies = [
		found.some((entry) => !entry.header)
			? 'An `envVariables` value is a readable service variable, which every member of the Zerops project can read, and it '
				+ 'sits in the repository in clear. Declare a credential in `pipeline.secrets` instead and set it with '
				+ '`fabrika control apps secrets put --app=<id> --name=<NAME>` (the value on stdin); Zerops stores it sensitive.'
			: '',
		found.some((entry) => entry.header)
			? 'A `routing.headers` value is sent to every visitor. A credential has no place there.'
			: '',
		'A value that is not a credential: list its variable or header name in `target.notSecret` of fabrika.config.ts.',
	].filter((line) => line !== '')
	throw new Error(['fabrika app build: plain configuration that looks like a credential:', ...lines, ...remedies].join('\n'))
}
