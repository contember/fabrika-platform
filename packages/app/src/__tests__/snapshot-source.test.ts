// The vendored snapshot module: the zod source `fabrika connect` writes from a served description reads back, through
// `describeSnapshot`, into the very shapes and digest it came from. The description is another application's
// answer, so no string in it may end a literal early or turn into code.

import type { ExportDescription, SchemaShape } from '@fabrika/auth-core'
import { exportDigest } from '@fabrika/auth-core'
import { checkApplication } from '@fabrika/check'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { compileContract } from '../contract/compile'
import { type ConnectSnapshot, describeSnapshot, exportDescription } from '../contract/connect'
import { ContractError } from '../contract/problems'
import { schemaFromShape } from '../contract/schema-from-shape'
import { snapshotNames, snapshotSource } from '../contract/snapshot-source'
import { contract as catalog } from './fixtures/connect-catalog/fabrika.contract'
import { catalogProductsV1 } from './fixtures/connect-shop/fabrika/connect/catalog.products.v1'

// Inside the package, so the generated module resolves `zod/v4` as an application's would.
const scratch = mkdtempSync(join(import.meta.dir, '.generated-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function isSnapshot(value: unknown): value is ConnectSnapshot {
	return typeof value === 'object' && value !== null && 'procedures' in value && 'digest' in value
}

/** Writes the module, loads it as Bun loads an application module, and answers its snapshot export. */
async function load(description: ExportDescription): Promise<{ readonly snapshot: ConnectSnapshot; readonly digest: unknown }> {
	const names = snapshotNames(description.app, description.export, description.version)
	const file = join(scratch, `${crypto.randomUUID()}.ts`)
	writeFileSync(file, snapshotSource(description))
	const loaded: Record<string, unknown> = await import(file)
	const snapshot = loaded[names.snapshot]
	if (!isSnapshot(snapshot)) {
		throw new Error('the generated module exports no snapshot')
	}
	return { snapshot, digest: loaded[names.digest] }
}

function described(procedures: ExportDescription['procedures']): ExportDescription {
	const rest = { app: 'my-catalog', export: 'products', version: 3, audience: 'any consumer user', procedures }
	return { ...rest, digest: exportDigest(rest) }
}

const string = (fields: Partial<Extract<SchemaShape, { type: 'string' }>> = {}): SchemaShape => ({
	type: 'string',
	format: null,
	minLength: null,
	maxLength: null,
	pattern: null,
	startsWith: null,
	endsWith: null,
	includes: null,
	...fields,
})

describe('the snapshot reads back into what it was written from', () => {
	test('the committed fixture is what the generator writes for the catalog today', () => {
		const description = exportDescription(compileContract(catalog, {}), 'products')
		if (description === null) {
			throw new Error('the catalog exports no products')
		}
		expect(describeSnapshot(catalogProductsV1)).toEqual(description)
	})

	test('every shape of the subset round-trips', async () => {
		const Every = z.strictObject({
			id: z.uuid(),
			email: z.email(),
			site: z.url(),
			at: z.iso.datetime(),
			day: z.iso.date(),
			code: z.string().min(2).max(8).regex(/^[A-Z]+\/?$/),
			affixed: z.string().startsWith('a').endsWith('z').includes('m'),
			count: z.int().gt(0).lte(10),
			ratio: z.number().gte(-1.5).lt(2).multipleOf(0.5),
			flag: z.boolean(),
			nothing: z.null(),
			kind: z.literal('product'),
			level: z.enum(['low', 'high']),
			tags: z.array(z.string()).min(1).max(3),
			pair: z.tuple([z.string(), z.int()]),
			rest: z.tuple([z.string()], z.boolean()),
			labels: z.record(z.string(), z.string()),
			maybe: z.optional(z.nullable(z.string())),
			either: z.union([z.literal(1), z.literal('one')]),
		})
		const artifact = compileContract(
			{
				...catalog,
				surface: {
					exports: {
						products: {
							kind: 'export',
							version: 3,
							consumers: ['shop'],
							audience: 'any consumer user',
							procedures: {
								every: { '~kind': 'procedure', type: 'query', input: Every, output: Every, access: { action: 'catalog.product.read', over: 'catalog' } },
							},
						},
					},
				},
			},
			{},
		)
		const description = exportDescription({ ...artifact, app: 'my-catalog' }, 'products')
		if (description === null) {
			throw new Error('no description')
		}
		const fixed = { ...description, digest: exportDigest(description) }
		const { snapshot, digest } = await load(fixed)
		expect(digest).toBe(fixed.digest)
		expect(describeSnapshot(snapshot)).toEqual(fixed)
		// The schemas a connector validates with are built from the same shapes and read back into them.
		const every = fixed.procedures['every']
		if (every === undefined) {
			throw new Error('no procedure')
		}
		const rebuilt = describeSnapshot({ ...snapshot, procedures: { every: { input: null, output: schemaFromShape(every.output) } } })
		expect(rebuilt.procedures['every']?.output).toEqual(every.output)
	})

	test('strings that would end a literal are written as their own characters', async () => {
		const hostile = `it's "quoted" \\ \`\${process.exit(1)}\` */ \n  </script>`
		const description = described({
			'products.get': {
				input: { type: 'object', fields: { [hostile]: string({ startsWith: hostile }) } },
				output: { type: 'union', options: [{ type: 'literal', value: hostile }, { type: 'enum', values: [hostile, 'b'] }] },
			},
		})
		const { snapshot } = await load(description)
		expect(describeSnapshot(snapshot)).toEqual(description)
		expect(Object.keys(snapshot.procedures)).toEqual(['products.get'])
	})

	test('a pattern that is not one regular-expression literal is refused, not written', () => {
		for (const pattern of ['a/);process.exit(1);(/', 'line\nbreak', '(unclosed', '(?:)']) {
			const description = described({ get: { input: null, output: string({ pattern }) } })
			expect(() => snapshotSource(description)).toThrow(ContractError)
		}
	})

	test('a field named __proto__ is refused: as a literal key it would set the prototype', () => {
		const fields: Record<string, SchemaShape> = Object.fromEntries([['__proto__', { type: 'null' }]])
		const description = described({ get: { input: null, output: { type: 'object', fields } } })
		expect(() => snapshotSource(description)).toThrow(ContractError)
	})

	test('the names: a hyphenated application id and one that starts with a digit', () => {
		expect(snapshotNames('my-catalog', 'products', 2)).toEqual({
			file: 'fabrika/connect/my-catalog.products.v2.ts',
			snapshot: 'myCatalogProductsV2',
			digest: 'myCatalogProductsV2Digest',
		})
		expect(snapshotNames('3d-store', 'items', 1).snapshot).toBe('app3dStoreItemsV1')
	})
})

describe('the consumer that vendors it', () => {
	test('@fabrika/check reads the shop, its contract and the vendored snapshot, with no finding', async () => {
		// The shop's handler module serves it through the framework's own test entry, which no application imports.
		const root = join(import.meta.dir, 'fixtures', 'connect-shop')
		const shell = ['fabrika.contract.ts', 'fabrika/connect/catalog.products.v1.ts']
		const files = new Map(shell.map((path) => [path, readFileSync(join(root, path), 'utf8')]))
		expect(await checkApplication({ root, files })).toEqual([])
	})
})
