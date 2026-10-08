import { z } from 'zod'

export interface RouterLeaf {
	method: string
	requirements: number
	/** Top-level keys of the procedure's input object; empty only for a procedure that takes no input. */
	inputKeys: string[]
}

/** Every procedure in a shipped router, as `a.b.c` with its authz requirement count and input keys. */
export function routerLeaves(node: unknown, path: string[] = []): RouterLeaf[] {
	if (node === null || typeof node !== 'object') {
		return []
	}
	const tag = Reflect.get(node, '_tag')
	if (tag === 'procedure') {
		const requirements = Reflect.get(node, 'requirements')
		return [{
			method: path.join('.'),
			requirements: Array.isArray(requirements) ? requirements.length : 0,
			inputKeys: objectKeys(Reflect.get(node, 'input')),
		}]
	}
	if (tag === 'router') {
		const def = Reflect.get(node, '_def')
		if (def === null || typeof def !== 'object') {
			return []
		}
		return Object.entries(def).flatMap(([key, child]) => routerLeaves(child, [...path, key]))
	}
	return []
}

/**
 * Fails closed: an input schema this cannot read throws, so a key check can never pass by reading
 * nothing. Only the builder's implicit "no input" schema has no keys.
 */
function objectKeys(schema: unknown): string[] {
	const unwrapped = unwrap(schema)
	if (unwrapped instanceof z.ZodObject) {
		return Object.keys(unwrapped.shape)
	}
	if (!(unwrapped instanceof z.ZodType) && isImplicitVoidInput(unwrapped)) {
		return []
	}
	throw new Error('unrecognized procedure input schema')
}

function unwrap(schema: unknown): unknown {
	if (schema instanceof z.ZodEffects) return unwrap(schema.innerType())
	if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return unwrap(schema.unwrap())
	if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault())
	if (schema instanceof z.ZodPipeline) return unwrap(schema._def.in)
	return schema
}

function isImplicitVoidInput(schema: unknown): boolean {
	if (schema === null || typeof schema !== 'object') {
		return false
	}
	const standard = Reflect.get(schema, '~standard')
	return standard !== null && typeof standard === 'object' && Reflect.get(standard, 'vendor') === 'fabrika'
}
