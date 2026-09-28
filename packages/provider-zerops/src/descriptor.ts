import type { JsonValue } from '@fabrika/provider-contract'
import { isAlias, isMap, isNode, isScalar, isSeq, parseAllDocuments } from 'yaml'
import { renderYaml } from './compile'

export interface ZeropsDescriptor {
	document: { readonly [key: string]: JsonValue }
	setups: readonly string[]
}

export interface PreparedZeropsDescriptor {
	contents: string
	setup: string
}

const invalid = (reason: string): never => {
	throw new Error(`invalid fabrika manifest: zerops.yaml ${reason}`)
}

const isMapping = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

// Compare decimal significands, not binary floats: parsing must not silently round source digits.
const decimalIdentity = (source: string): string => {
	const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(source)
	if (match === null) return invalid('contains an unsupported numeric representation')
	const fraction = match[3] ?? ''
	const digits = `${match[2] ?? ''}${fraction}`.replace(/^0+/, '')
	if (digits === '') return '0'
	const significant = digits.replace(/0+$/, '')
	const exponent = BigInt(match[4] ?? '0') - BigInt(fraction.length) + BigInt(digits.length - significant.length)
	return `${match[1] === '-' ? '-' : ''}${significant}e${exponent}`
}

const decodeNode = (node: unknown): JsonValue => {
	if (isAlias(node)) return invalid('must not contain aliases')
	if (!isNode(node)) return invalid('contains an unsupported node')
	if (node.tag !== undefined) return invalid('must not contain explicit tags')
	if ('anchor' in node && node.anchor !== undefined) return invalid('must not contain anchors')
	if (isMap(node)) {
		const entries: Array<[string, JsonValue]> = []
		const keys = new Set<string>()
		for (const pair of node.items) {
			const key = decodeNode(pair.key)
			if (typeof key !== 'string') return invalid('requires string mapping keys')
			if (key === '<<') return invalid('must not contain merge keys')
			if (keys.has(key)) return invalid('must not contain duplicate keys')
			keys.add(key)
			entries.push([key, decodeNode(pair.value)])
		}
		return Object.fromEntries(entries)
	}
	if (isSeq(node)) return node.items.map(decodeNode)
	if (!isScalar(node)) return invalid('contains an unsupported node')
	const value: unknown = node.value
	if (typeof value === 'bigint') {
		const number = Number(value)
		if (!Number.isSafeInteger(number)) return invalid('contains an inexact number')
		return number
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return invalid('contains an inexact number')
		if (node.source === undefined || decimalIdentity(node.source) !== decimalIdentity(String(value))) return invalid('contains an inexact number')
		return value
	}
	if (typeof value === 'string' && /\p{Surrogate}/u.test(value)) return invalid('contains an invalid Unicode scalar')
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	return invalid('contains an unsupported scalar')
}

const parseDocument = (contents: string, schema: 'core' | 'yaml-1.1'): JsonValue => {
	const documents = parseAllDocuments(contents, { schema, intAsBigInt: true, merge: false, resolveKnownTags: false, uniqueKeys: true })
	const document = documents[0]
	if (documents.length !== 1 || document === undefined) return invalid('requires exactly one mapping document')
	if (document.errors.length > 0 || document.warnings.length > 0) return invalid('is not parseable YAML without errors or warnings')
	return decodeNode(document.contents)
}

export const parseZeropsDescriptor = (contents: string): ZeropsDescriptor => {
	// Go readers fold or reject these raw characters; escaped string data remains supported.
	if (/[\u007f-\u009f\u2028\u2029\ufffe\uffff]/u.test(contents)) return invalid('contains raw characters unsupported by YAML-1.1 readers')
	const document = parseDocument(contents, 'core')
	const legacy = parseDocument(contents, 'yaml-1.1')
	if (JSON.stringify(document) !== JSON.stringify(legacy)) return invalid('contains ambiguous plain scalars; quote them explicitly')
	if (!isMapping(document)) return invalid('requires a mapping document')
	const entries = document['zerops']
	if (!Array.isArray(entries) || entries.length === 0) return invalid('requires a nonempty zerops sequence')
	const setups: string[] = []
	for (const entry of entries) {
		if (!isMapping(entry) || typeof entry['setup'] !== 'string' || entry['setup'].trim() === '') return invalid('requires string setup names')
		if (setups.includes(entry['setup'])) return invalid('must not contain duplicate setup names')
		setups.push(entry['setup'])
		for (const phase of ['build', 'run']) {
			const config = entry[phase]
			if (config === undefined) continue
			if (!isMapping(config)) return invalid('requires build and run mappings')
			const env = config['envVariables']
			if (env !== undefined && (!isMapping(env) || Object.values(env).some((value) => typeof value !== 'string'))) {
				return invalid('requires envVariables string mappings')
			}
		}
	}
	return { document, setups }
}

export const prepareZeropsDescriptor = (contents: string, setup?: string): PreparedZeropsDescriptor => {
	const parsed = parseZeropsDescriptor(contents)
	const selected = setup ?? (parsed.setups.length === 1 ? parsed.setups[0] : undefined)
	if (selected === undefined) return invalid('requires an explicit setup selector for multiple setups')
	if (!parsed.setups.includes(selected)) return invalid('does not contain the selected setup')
	return { contents: renderYaml(parsed.document), setup: selected }
}
