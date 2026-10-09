// The consumer of a connector: a shop that shows catalog products through the catalog's export, and only from the
// endpoint its import's `usedBy` names.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { catalogProductsV1Digest } from './fabrika/connect/catalog.products.v1'

export const Show = z.strictObject({ sku: z.string() })
export const Shown = z.strictObject({ outcome: z.string(), name: z.nullable(z.string()) })
export const Seen = z.strictObject({ connect: z.boolean() })

export const contract = defineContract({
	app: 'shop',
	dimensions: { shop: {} },
	actions: { 'shop.view': 'Browse the shop' },
	roles: { visitor: { grants: ['shop.view'] } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		products: {
			show: c.query({ input: Show, output: Shown, access: { action: 'shop.view', over: 'shop' } }),
			other: c.query({ output: Seen, access: { action: 'shop.view', over: 'shop' } }),
		},
	}),
	imports: {
		catalog: {
			app: 'catalog',
			export: 'products',
			version: 1,
			digest: catalogProductsV1Digest,
			procedures: ['get'],
			usedBy: ['api.products.show'],
			timeoutMs: 400,
		},
	},
}))
