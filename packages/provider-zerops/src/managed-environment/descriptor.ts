import type { JsonValue } from '@fabrika/provider-contract'
import { renderYaml } from '../compile'
import { parseZeropsDescriptor, type PreparedZeropsDescriptor } from '../descriptor'
import { assertAuthoredManagedDocument } from './authored'
import { type ConfirmedManagedBinding, MANAGED_KEYS, requireConfirmedBinding } from './protocol'

const isMapping = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only nonsecret, confirmed references cross this boundary; original source bytes remain untouched. */
export function prepareManagedDescriptor(contents: string, setup: string | undefined, input: ConfirmedManagedBinding): PreparedZeropsDescriptor {
	const binding = requireConfirmedBinding(input)
	const parsed = parseZeropsDescriptor(contents)
	assertAuthoredManagedDocument(parsed.document)
	const selected = setup ?? (parsed.setups.length === 1 ? parsed.setups[0] : undefined)
	if (selected === undefined || !parsed.setups.includes(selected)) throw new Error('zerops: managed descriptor requires a valid setup selector')
	const entries = parsed.document['zerops']
	if (!Array.isArray(entries)) throw new Error('zerops: managed descriptor requires setup entries')
	const overlaid = entries.map((entry) => {
		if (!isMapping(entry) || entry['setup'] !== selected) return entry
		const run = entry['run']
		const runMapping = isMapping(run) ? run : {}
		const env = runMapping['envVariables']
		const envMapping = isMapping(env) ? env : {}
		const references: Record<string, JsonValue> = { ...envMapping }
		for (const key of MANAGED_KEYS) {
			const value = binding[key]
			if (value.state === 'confirmed') references[key] = `\${${value.referenceName}}`
		}
		return { ...entry, run: { ...runMapping, envVariables: references } }
	})
	return { contents: renderYaml({ ...parsed.document, zerops: overlaid }), setup: selected }
}
