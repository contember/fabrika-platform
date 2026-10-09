// The owner of a connector: a catalog that exports its products, read-only, to the shop.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const BySku = z.strictObject({ sku: z.string().min(1).max(64) })
export const Product = z.strictObject({
	sku: z.string(),
	name: z.string(),
	price: z.int().nonnegative(),
	tags: z.array(z.enum(['new', 'sale'])).max(4),
	note: z.optional(z.string()),
})
export const ProductPage = z.strictObject({ items: z.array(Product), next: z.nullable(z.string()) })

export const contract = defineContract({
	app: 'catalog',
	dimensions: { catalog: {} },
	actions: {
		'catalog.product.read': 'Read the products',
		'catalog.product.write': 'Edit the products',
	},
	roles: {
		reader: { grants: ['catalog.product.read'] },
		editor: { grants: ['catalog.product.read', 'catalog.product.write'] },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		products: {
			get: c.query({ input: BySku, output: z.nullable(Product), access: { action: 'catalog.product.read', over: 'catalog' } }),
		},
	}),
	exports: {
		products: c.export({
			version: 1,
			consumers: ['shop'],
			audience: 'any consumer user',
			procedures: {
				get: c.query({ input: BySku, output: z.nullable(Product), access: { action: 'catalog.product.read', over: 'catalog' } }),
				list: c.query({ output: ProductPage, access: { action: 'catalog.product.read', over: 'catalog' } }),
			},
		}),
	},
}))
