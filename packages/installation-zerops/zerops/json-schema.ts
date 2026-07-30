// A minimal JSON Schema (draft 2020-12) validator — just enough to check a document against Zerops'
// PUBLISHED schemas, and no more.
//
// WHY THIS EXISTS RATHER THAN `ajv`. The repo has no JSON-schema dependency and adding one to validate
// two vendored documents is a poor trade. The alternative risk — "we wrote our own validator, so a
// constraint it silently ignores looks like a pass" — is closed by `unsupportedKeywords()`: it walks a
// schema and reports every keyword this file does not implement, and a test asserts that set is EMPTY
// for both vendored schemas. So the claim "zero errors" is only ever made about a schema whose every
// keyword is actually enforced here. If Zerops adds a `pattern` or a `minItems` tomorrow, the refresh
// script's test fails loudly instead of quietly weakening the check.
//
// Implemented: $ref (internal pointers only), type, enum, const, properties, required,
// additionalProperties, items, minimum, maximum, allOf, anyOf, oneOf, not, if/then/else.
// Ignored deliberately (annotations, not constraints): $schema, $id, $defs, title, description,
// default, deprecated, examples.

/** One failure, addressed by a JSON-pointer-ish path into the INSTANCE (not the schema). */
export interface SchemaViolation {
	/** Instance path, e.g. `services[2].verticalAutoscaling.cpu`. `''` is the document root. */
	path: string
	message: string
}

/** Keywords this validator enforces. */
const CONSTRAINT_KEYWORDS = new Set([
	'$ref',
	'type',
	'enum',
	'const',
	'properties',
	'required',
	'additionalProperties',
	'items',
	'minimum',
	'maximum',
	'allOf',
	'anyOf',
	'oneOf',
	'not',
	'if',
	'then',
	'else',
])

/** Keywords that carry no constraint, so ignoring them is correct rather than a gap. */
const ANNOTATION_KEYWORDS = new Set(['$schema', '$id', '$comment', '$defs', 'title', 'description', 'default', 'deprecated', 'examples'])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const asArray = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined)

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

const deepEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) {
		return true
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
	}
	if (isRecord(a) && isRecord(b)) {
		const keys = Object.keys(a)
		return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]))
	}
	return false
}

/** Resolve an internal `#/a/b` pointer. Returns `undefined` for anything external or unresolvable. */
const resolveRef = (root: unknown, ref: string): unknown => {
	if (!ref.startsWith('#/')) {
		return undefined
	}
	let node: unknown = root
	for (const rawSegment of ref.slice(2).split('/')) {
		const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
		if (!isRecord(node)) {
			return undefined
		}
		node = node[segment]
	}
	return node
}

const typeMatches = (type: string, value: unknown): boolean => {
	switch (type) {
		case 'object':
			return isRecord(value)
		case 'array':
			return Array.isArray(value)
		case 'string':
			return typeof value === 'string'
		case 'integer':
			return typeof value === 'number' && Number.isInteger(value)
		case 'number':
			return typeof value === 'number'
		case 'boolean':
			return typeof value === 'boolean'
		case 'null':
			return value === null
		default:
			return false
	}
}

const child = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`)

const describe = (value: unknown): string => (typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? 'undefined')

/** Core recursion. Appends to `out`; a schema of `true`/`false` is the always/never schema. */
const check = (schema: unknown, value: unknown, path: string, root: unknown, out: SchemaViolation[]): void => {
	if (schema === true || schema === undefined) {
		return
	}
	if (schema === false) {
		out.push({ path, message: 'schema is `false` — no value is valid here' })
		return
	}
	if (!isRecord(schema)) {
		out.push({ path, message: 'malformed schema node' })
		return
	}

	const ref = asString(schema['$ref'])
	if (ref !== undefined) {
		const target = resolveRef(root, ref)
		if (target === undefined) {
			out.push({ path, message: `unresolvable $ref \`${ref}\`` })
		} else {
			check(target, value, path, root, out)
		}
	}

	// ── type ────────────────────────────────────────────────────────────────────
	const type = schema['type']
	if (type !== undefined) {
		const types = typeof type === 'string' ? [type] : (asArray(type) ?? []).flatMap((entry) => (typeof entry === 'string' ? [entry] : []))
		if (types.length > 0 && !types.some((candidate) => typeMatches(candidate, value))) {
			out.push({ path, message: `expected type ${types.join('|')}, got ${value === null ? 'null' : typeof value}` })
			// A wrong type makes every other keyword's report noise; stop here.
			return
		}
	}

	// ── enum / const ────────────────────────────────────────────────────────────
	const members = asArray(schema['enum'])
	if (members !== undefined && !members.some((member) => deepEqual(member, value))) {
		out.push({ path, message: `${describe(value)} is not one of the ${members.length} allowed values` })
	}
	if ('const' in schema && !deepEqual(schema['const'], value)) {
		out.push({ path, message: `${describe(value)} !== ${describe(schema['const'])}` })
	}

	// ── numbers ─────────────────────────────────────────────────────────────────
	if (typeof value === 'number') {
		const minimum = asNumber(schema['minimum'])
		if (minimum !== undefined && value < minimum) {
			out.push({ path, message: `${value} < minimum ${minimum}` })
		}
		const maximum = asNumber(schema['maximum'])
		if (maximum !== undefined && value > maximum) {
			out.push({ path, message: `${value} > maximum ${maximum}` })
		}
	}

	// ── objects ─────────────────────────────────────────────────────────────────
	if (isRecord(value)) {
		const properties = isRecord(schema['properties']) ? schema['properties'] : {}
		for (const name of (asArray(schema['required']) ?? []).flatMap((entry) => (typeof entry === 'string' ? [entry] : []))) {
			if (!(name in value)) {
				out.push({ path, message: `missing required property \`${name}\`` })
			}
		}
		for (const [key, entry] of Object.entries(value)) {
			if (key in properties) {
				check(properties[key], entry, child(path, key), root, out)
				continue
			}
			const additional = schema['additionalProperties']
			if (additional === false) {
				out.push({ path: child(path, key), message: 'unknown property (additionalProperties: false)' })
				continue
			}
			if (additional !== undefined) {
				check(additional, entry, child(path, key), root, out)
			}
		}
	}

	// ── arrays ──────────────────────────────────────────────────────────────────
	if (Array.isArray(value) && schema['items'] !== undefined) {
		value.forEach((entry, index) => {
			check(schema['items'], entry, `${path}[${index}]`, root, out)
		})
	}

	// ── combinators ─────────────────────────────────────────────────────────────
	for (const branch of asArray(schema['allOf']) ?? []) {
		check(branch, value, path, root, out)
	}
	const anyOf = asArray(schema['anyOf'])
	if (anyOf !== undefined && !anyOf.some((branch) => check1(branch, value, path, root))) {
		out.push({ path, message: 'matched none of the `anyOf` branches' })
	}
	const oneOf = asArray(schema['oneOf'])
	if (oneOf !== undefined) {
		const matched = oneOf.filter((branch) => check1(branch, value, path, root)).length
		if (matched !== 1) {
			out.push({ path, message: `matched ${matched} of the \`oneOf\` branches, expected exactly 1` })
		}
	}
	if ('not' in schema && check1(schema['not'], value, path, root)) {
		out.push({ path, message: 'matched the `not` schema' })
	}

	// ── if / then / else ────────────────────────────────────────────────────────
	if ('if' in schema) {
		const taken = check1(schema['if'], value, path, root) ? schema['then'] : schema['else']
		if (taken !== undefined) {
			check(taken, value, path, root, out)
		}
	}
}

/** Does `value` satisfy `schema`? (Used for combinator branches, where errors are not reported.) */
const check1 = (schema: unknown, value: unknown, path: string, root: unknown): boolean => {
	const out: SchemaViolation[] = []
	check(schema, value, path, root, out)
	return out.length === 0
}

/** Validate `value` against `schema`. An empty array means the document is valid. */
export const validateAgainstSchema = (schema: unknown, value: unknown): SchemaViolation[] => {
	const out: SchemaViolation[] = []
	check(schema, value, '', schema, out)
	return out
}

/**
 * Every keyword in `schema` this validator neither enforces nor deliberately ignores — the honesty
 * check. A non-empty result means a constraint is being skipped, so a "valid" verdict would be worth
 * less than it looks.
 */
export const unsupportedKeywords = (schema: unknown): string[] => {
	const found = new Set<string>()
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach(walk)
			return
		}
		if (!isRecord(node)) {
			return
		}
		for (const [keyword, entry] of Object.entries(node)) {
			if (!CONSTRAINT_KEYWORDS.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword)) {
				found.add(keyword)
			}
			// `properties` / `$defs` map NAMES to schemas, so their keys are data, not keywords.
			if (keyword === 'properties' || keyword === '$defs') {
				if (isRecord(entry)) {
					Object.values(entry).forEach(walk)
				}
				continue
			}
			// `enum` / `const` / `required` hold instance data, never sub-schemas.
			if (keyword === 'enum' || keyword === 'const' || keyword === 'required' || keyword === 'examples' || keyword === 'default') {
				continue
			}
			walk(entry)
		}
	}
	walk(schema)
	return [...found].sort()
}
