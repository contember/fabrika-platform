// The shared encoding restores the canonical artifact exactly, so the digest of what boot decodes is the approved one,
// and it refuses a reference that does not point back to a shape written before it.

import { compileContract, defineContract, parseEncodedArtifact } from '@fabrika/app/contract'
import { isContractImplementation } from '@fabrika/app/implement'
import {
	canonicalArtifactDigest,
	canonicalizeArtifact,
	type ContractArtifact,
	contractDigest,
	encodeArtifact,
	encodedArtifactJson,
	SHARED_SHAPES_ENCODING,
} from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { notesApp } from './fixtures/implement/app'

const EXAMPLES = join(import.meta.dir, '..', '..', '..', '..', 'examples')

/** A worked application's compiled contract, imported by path: the examples are programs of their own. */
async function exampleArtifact(example: string): Promise<ContractArtifact> {
	const module: unknown = await import(join(EXAMPLES, example, 'src', 'app.ts'))
	const app = typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
	if (!isContractImplementation(app)) throw new Error(`${example} does not default-export serve(contract, { … })`)
	return compileContract(app.contract, app.database?.tables ?? {})
}

async function artifacts(): Promise<readonly [string, ContractArtifact][]> {
	const notes = notesApp(new Map())
	return [
		['the notes fixture', compileContract(notes.contract, notes.database?.tables ?? {})],
		...await Promise.all(
			['app', 'crm', 'zerops-app'].map(async (example): Promise<[string, ContractArtifact]> => [example, await exampleArtifact(example)]),
		),
	]
}

describe('the shared encoding', () => {
	test('decodes to the canonical artifact, whose digest is the contract digest', async () => {
		for (const [name, artifact] of await artifacts()) {
			const decoded = parseEncodedArtifact(JSON.parse(encodedArtifactJson(artifact)))
			expect(decoded, name).toEqual(canonicalizeArtifact(artifact))
			expect(canonicalArtifactDigest(decoded), name).toBe(contractDigest(artifact))
			expect(encodedArtifactJson(decoded), name).toBe(encodedArtifactJson(artifact))
		}
	})

	test('writes a repeated shape once, and decodes it to one object', () => {
		const Item = z.strictObject({ id: z.string(), title: z.string().min(1), tags: z.array(z.string()) })
		const contract = defineContract({
			app: 'notes',
			dimensions: { workspace: {} },
			actions: { 'notes.read': 'Read notes' },
			roles: { reader: { grants: ['notes.read'] } },
		}, (c) => ({
			api: c.rpc('/api', { callers: ['human'] }, {
				first: c.query({ output: Item, access: { action: 'notes.read', over: 'workspace' } }),
				second: c.query({ output: Item, access: { action: 'notes.read', over: 'workspace' } }),
			}),
		}))
		const artifact = compileContract(contract, {})
		const encoded = encodeArtifact(artifact)
		expect(encoded.shapes.length).toBeGreaterThan(0)
		expect(JSON.stringify(encoded)).not.toContain('"minLength":null')
		const decoded = parseEncodedArtifact(JSON.parse(JSON.stringify(encoded)))
		const [first, second] = ['api.first', 'api.second'].map((id) => decoded.endpoints.find((row) => row.id === id)?.output)
		expect(first).toBeDefined()
		expect(first).toBe(second)
		expect(canonicalArtifactDigest(decoded)).toBe(contractDigest(artifact))
	})

	test('refuses a reference to a shape not written before it', () => {
		const object = { type: 'object', fields: { id: { type: 'string' } } }
		const artifact = JSON.parse(encodedArtifactJson(compileContract(notesApp(new Map()).contract, {})))
		expect(() => parseEncodedArtifact({ ...artifact, shapes: [{ type: 'shared', index: 0 }] })).toThrow('is not written before it is referenced')
		expect(() => parseEncodedArtifact({ ...artifact, shapes: [{ type: 'array', items: { type: 'shared', index: 1 } }, object] })).toThrow(
			'is not written before it is referenced',
		)
		expect(() => parseEncodedArtifact({ ...artifact, encoding: 'plain' })).toThrow()
		expect(() => parseEncodedArtifact({ ...artifact, shapes: [{ ...object, extra: true }] })).toThrow()
		expect(artifact.encoding).toBe(SHARED_SHAPES_ENCODING)
	})
})
