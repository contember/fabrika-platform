// The compatibility rule Control applies to an owner deploy (B9b): what the change of an export version breaks for a
// consumer that imports some of its procedures.

import type { ExportDescription } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract } from '../contract/compile'
import { exportDescription, incompatibleChanges } from '../contract/connect'
import { defineContract, type Schema } from '../contract/define'

type StrictInput = z.ZodObject<z.core.$ZodShape, z.core.$strict>

const Product = z.strictObject({ sku: z.string(), name: z.string() })

function catalog(shapes: { readonly input?: StrictInput; readonly output?: Schema; readonly withList?: boolean }): ExportDescription {
	const input = shapes.input ?? z.strictObject({ sku: z.string() })
	const output = shapes.output ?? z.nullable(Product)
	const contract = defineContract({
		app: 'catalog',
		dimensions: { catalog: {} },
		actions: { 'catalog.product.read': 'Read the products' },
		roles: { reader: { grants: ['catalog.product.read'] } },
	}, (c) => ({
		exports: {
			products: c.export({
				version: 1,
				consumers: ['shop'],
				audience: 'any consumer user',
				procedures: {
					get: c.query({ input, output, access: { action: 'catalog.product.read', over: 'catalog' } }),
					...(shapes.withList === false
						? {}
						: { list: c.query({ output: z.array(Product), access: { action: 'catalog.product.read', over: 'catalog' } }) }),
				},
			}),
		},
	}))
	const description = exportDescription(compileContract(contract, {}), 'products')
	if (description === null) throw new Error('the catalog exports products')
	return description
}

const before = catalog({})

describe('incompatibleChanges', () => {
	test('an unchanged export, a new optional input field and a procedure the consumer does not import are compatible', () => {
		expect(incompatibleChanges(before, catalog({}), ['get', 'list'])).toEqual([])
		expect(incompatibleChanges(before, catalog({ input: z.strictObject({ sku: z.string(), locale: z.optional(z.string()) }) }), ['get'])).toEqual([])
		expect(incompatibleChanges(before, catalog({ withList: false }), ['get'])).toEqual([])
	})

	test('a removed procedure the consumer imports is refused', () => {
		expect(incompatibleChanges(before, catalog({ withList: false }), ['get', 'list'])).toEqual(["removes 'list'"])
	})

	test('an output field removed, added or retyped is refused: the consumer parses every answer strictly', () => {
		const removed = z.nullable(z.strictObject({ sku: z.string() }))
		const added = z.nullable(z.strictObject({ sku: z.string(), name: z.string(), price: z.int() }))
		const retyped = z.nullable(z.strictObject({ sku: z.string(), name: z.int() }))
		for (const output of [removed, added, retyped]) {
			expect(incompatibleChanges(before, catalog({ output }), ['get'])).toEqual(["'get' answers another output than before"])
		}
	})

	test('a new required input field, a removed one, a narrowed one and optional made required are refused', () => {
		const inputs = [
			z.strictObject({ sku: z.string(), locale: z.string() }),
			z.strictObject({}),
			z.strictObject({ sku: z.string().max(8) }),
		]
		for (const input of inputs) {
			expect(incompatibleChanges(before, catalog({ input }), ['get'])).toEqual(["'get' accepts less input than before"])
		}
		const optional = catalog({ input: z.strictObject({ sku: z.string(), locale: z.optional(z.string()) }) })
		expect(incompatibleChanges(optional, catalog({ input: z.strictObject({ sku: z.string(), locale: z.string() }) }), ['get'])).toEqual([
			"'get' accepts less input than before",
		])
	})
})
