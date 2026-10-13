import type { JsonValue } from '@fabrika/provider-contract'
import { isAlias, isMap, isNode, isScalar, isSeq, parseAllDocuments } from 'yaml'
import { z } from 'zod'
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

const descriptorJsonSchema: z.ZodType<JsonValue, z.ZodTypeDef, unknown> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(descriptorJsonSchema),
		descriptorMappingSchema,
	])
)
// Zod records drop __proto__; descriptor mappings must preserve every decoded key and its order.
const descriptorMappingSchema: z.ZodType<{ [key: string]: JsonValue }, z.ZodTypeDef, unknown> = z.preprocess(
	(value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : null,
	z.array(z.tuple([z.string(), descriptorJsonSchema])).transform((entries) => Object.fromEntries(entries)),
)
const phaseSchema = z.intersection(descriptorMappingSchema, z.object({ envVariables: z.record(z.string()).optional() }))
const setupSchema = z.intersection(
	descriptorMappingSchema,
	z.object({
		setup: z.string().refine((value) => value.trim() !== ''),
		build: phaseSchema.optional(),
		run: phaseSchema.optional(),
	}),
)
const descriptorDocumentSchema = z.intersection(descriptorMappingSchema, z.object({ zerops: z.array(setupSchema).min(1) }))

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
	const result = descriptorDocumentSchema.safeParse(document)
	if (!result.success) {
		const path = result.error.issues[0]?.path ?? []
		if (path.includes('envVariables')) return invalid('requires envVariables string mappings')
		if (path.includes('build') || path.includes('run')) return invalid('requires build and run mappings')
		if (path.length > 1) return invalid('requires string setup names')
		return invalid(path.length === 0 ? 'requires a mapping document' : 'requires a nonempty zerops sequence')
	}
	const setups: string[] = []
	for (const entry of result.data.zerops) {
		if (setups.includes(entry.setup)) return invalid('must not contain duplicate setup names')
		setups.push(entry.setup)
	}
	return { document: result.data, setups }
}

export const selectZeropsDescriptorSetup = (parsed: ZeropsDescriptor, setup?: string): string => {
	const selected = setup ?? (parsed.setups.length === 1 ? parsed.setups[0] : undefined)
	if (selected === undefined) return invalid('requires an explicit setup selector for multiple setups')
	if (!parsed.setups.includes(selected)) return invalid('does not contain the selected setup')
	return selected
}

const inheritanceSchema = z.object({
	zerops: z.array(z.intersection(
		descriptorMappingSchema,
		z.object({ setup: z.string(), extends: z.union([z.string(), z.array(z.string())]).optional() }),
	)),
})

/**
 * The setup entries a deploy of `selected` applies: the selected one and, transitively, every setup it
 * `extends`. Only these reach the running service; the other setups in the file never do.
 */
export const appliedZeropsSetups = (parsed: ZeropsDescriptor, selected: string): JsonValue[] => {
	const document = inheritanceSchema.safeParse(parsed.document)
	if (!document.success) return invalid('requires extends to name setups')
	const applied: JsonValue[] = []
	const visit = (name: string): void => {
		const entry = document.data.zerops.find((candidate) => candidate.setup === name)
		if (entry === undefined) return invalid(`extends unknown setup \`${name}\``)
		if (applied.includes(entry)) return
		applied.push(entry)
		for (const parent of typeof entry.extends === 'string' ? [entry.extends] : entry.extends ?? []) visit(parent)
	}
	visit(selected)
	return applied
}

/**
 * Refuse a selected setup that `extends` another without its own `run`: Zerops merges `extends` per
 * whole section, and the deploy writes `FABRIKA_RELEASE` into `run`, which would replace the inherited one.
 */
export const assertOwnRunWhenExtending = (parsed: ZeropsDescriptor, selected: string): void => {
	const [entry] = appliedZeropsSetups(parsed, selected)
	if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return
	if (entry['extends'] !== undefined && entry['run'] === undefined) {
		invalid(`setup \`${selected}\` extends another setup, so it must declare its own run section — the deploy writes FABRIKA_RELEASE into it`)
	}
}

/** The document Zerops executes: the selected setup and what it extends, which is exactly what the ownership check read. */
export const executionZeropsDocument = (parsed: ZeropsDescriptor, selected: string): { readonly [key: string]: JsonValue } => ({
	...parsed.document,
	zerops: appliedZeropsSetups(parsed, selected),
})

export const prepareZeropsDescriptor = (contents: string, setup?: string): PreparedZeropsDescriptor => {
	const parsed = parseZeropsDescriptor(contents)
	const selected = selectZeropsDescriptorSetup(parsed, setup)
	return { contents: renderYaml(executionZeropsDocument(parsed, selected)), setup: selected }
}
