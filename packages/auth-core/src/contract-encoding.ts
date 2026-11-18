// The shared encoding of a contract artifact: how a build bundles it and how Control stores a large one. Each composite
// schema shape that occurs more than once is written once, in `shapes`, and referenced by its index; a shape's null
// constraints are left out. Decoding (`@fabrika/app/contract`) restores the canonical artifact exactly, so its digest
// is the one `contractDigest` takes: the encoding is a storage form, never what a digest is taken over.

import type { ContractArtifact, OutputShape, SchemaShape } from './contract'
import { canonicalizeArtifact, canonicalJson } from './contract-canonical'

/** The `encoding` of an encoded artifact; a plain artifact has no such key. */
export const SHARED_SHAPES_ENCODING = 'shared-shapes'

/** In place of a shape: `shapes[index]` of the encoded artifact, which is always written before it is referenced. */
export interface SharedShapeReference {
	readonly type: 'shared'
	readonly index: number
}

/** An artifact in the shared encoding, as JSON. */
export interface EncodedArtifact {
	readonly encoding: typeof SHARED_SHAPES_ENCODING
	readonly shapes: readonly object[]
	readonly artifact: object
}

/** The canonical artifact in the shared encoding. */
export function encodeArtifact(artifact: ContractArtifact): EncodedArtifact {
	const canonical = canonicalizeArtifact(artifact)
	const interner = new ShapeInterner()
	mapShapes(canonical, (shape) => {
		interner.node(shape).uses++
		return null
	})
	for (const node of interner.nodes) {
		for (const child of node.children) child.uses++
	}
	const writer = new SharedWriter(interner)
	const encoded = mapShapes(canonical, (shape) => writer.write(shape))
	return { encoding: SHARED_SHAPES_ENCODING, shapes: writer.shapes, artifact: encoded }
}

/** The encoded artifact as text, keys sorted: what a build bundles. */
export function encodedArtifactJson(artifact: ContractArtifact): string {
	return canonicalJson(encodeArtifact(artifact))
}

/** One distinct shape: equal shapes, wherever they occur, are one node. */
interface ShapeNode {
	readonly id: number
	readonly shape: SchemaShape
	readonly children: readonly ShapeNode[]
	uses: number
}

class ShapeInterner {
	readonly nodes: ShapeNode[] = []
	readonly #byForm = new Map<string, ShapeNode>()
	readonly #byObject = new WeakMap<SchemaShape, ShapeNode>()

	node(shape: SchemaShape): ShapeNode {
		const known = this.#byObject.get(shape)
		if (known !== undefined) return known
		const children: ShapeNode[] = []
		// A node's identity is its own fields and its children's identities, so equal subtrees are found bottom up.
		const form = canonicalJson(compactShape(shape, (child) => {
			const node = this.node(child)
			children.push(node)
			return node.id
		}))
		let node = this.#byForm.get(form)
		if (node === undefined) {
			node = { id: this.nodes.length, shape, children, uses: 0 }
			this.nodes.push(node)
			this.#byForm.set(form, node)
		}
		this.#byObject.set(shape, node)
		return node
	}
}

class SharedWriter {
	readonly shapes: object[] = []
	readonly #indexes = new Map<ShapeNode, number>()
	readonly #interner: ShapeInterner

	constructor(interner: ShapeInterner) {
		this.#interner = interner
	}

	write(shape: SchemaShape): object {
		const node = this.#interner.node(shape)
		if (node.children.length === 0 || node.uses < 2) {
			return compactShape(shape, (child) => this.write(child))
		}
		let index = this.#indexes.get(node)
		if (index === undefined) {
			// Children first, so every reference points to a shape written before it.
			const written = compactShape(shape, (child) => this.write(child))
			index = this.shapes.length
			this.shapes.push(written)
			this.#indexes.set(node, index)
		}
		const reference: SharedShapeReference = { type: 'shared', index }
		return reference
	}
}

/** The shape without its null constraints, each child replaced by `child`'s answer; an object's fields in key order. */
function compactShape(shape: SchemaShape, child: (shape: SchemaShape) => unknown): object {
	switch (shape.type) {
		case 'string':
			return {
				type: 'string',
				...present('format', shape.format),
				...present('minLength', shape.minLength),
				...present('maxLength', shape.maxLength),
				...present('pattern', shape.pattern),
				...present('startsWith', shape.startsWith),
				...present('endsWith', shape.endsWith),
				...present('includes', shape.includes),
			}
		case 'number':
			return {
				type: 'number',
				int: shape.int,
				...present('min', shape.min),
				exclusiveMin: shape.exclusiveMin,
				...present('max', shape.max),
				exclusiveMax: shape.exclusiveMax,
				...present('multipleOf', shape.multipleOf),
			}
		case 'array':
			return { type: 'array', items: child(shape.items), ...present('minItems', shape.minItems), ...present('maxItems', shape.maxItems) }
		case 'tuple':
			return { type: 'tuple', items: shape.items.map(child), ...(shape.rest === null ? {} : { rest: child(shape.rest) }) }
		case 'record':
			return { type: 'record', key: child(shape.key), value: child(shape.value) }
		case 'object':
			return { type: 'object', fields: Object.fromEntries(sortedEntries(shape.fields).map(([name, field]) => [name, child(field)])) }
		case 'optional':
		case 'nullable':
			return { type: shape.type, inner: child(shape.inner) }
		case 'union':
			return { type: 'union', options: shape.options.map(child) }
		default:
			return shape
	}
}

function present(key: string, value: string | number | null): object {
	return value === null ? {} : { [key]: value }
}

/** The artifact with each schema shape replaced by `map`'s answer; records are visited in key order. */
function mapShapes(artifact: ContractArtifact, map: (shape: SchemaShape) => unknown): object {
	const output = (shape: OutputShape): unknown => {
		if (shape.type === 'redirect') return shape
		if (shape.type === 'attachment') return { ...shape, columns: shape.columns.map((column) => ({ name: column.name, shape: map(column.shape) })) }
		return map(shape)
	}
	const endpoints = artifact.endpoints.map((row) => ({
		...row,
		input: row.input === null ? null : map(row.input),
		output: row.output === null ? null : output(row.output),
	}))
	const procedures = artifact.procedures === undefined ? undefined : Object.fromEntries(
		sortedEntries(artifact.procedures).map(([id, rules]) => [id, rules.query === undefined ? rules : { ...rules, query: map(rules.query) }]),
	)
	const tokens = artifact.tokens === undefined ? undefined : Object.fromEntries(
		sortedEntries(artifact.tokens).map(([purpose, token]) => [purpose, { ...token, claims: map(token.claims) }]),
	)
	return {
		...artifact,
		endpoints,
		...(procedures === undefined ? {} : { procedures }),
		...(tokens === undefined ? {} : { tokens }),
	}
}

function sortedEntries<T>(record: Readonly<Record<string, T>>): [string, T][] {
	return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}
