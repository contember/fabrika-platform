// The shop's handlers: `show` reads a product through the connector and reports the outcome it got.

import { implement } from '../../../../implement/implement'
import { contract } from '../fabrika.contract'
import { catalogProductsV1 } from '../fabrika/connect/catalog.products.v1'

export const app = implement(contract, {
	database: null,
	connect: { catalog: catalogProductsV1 },
	deps: () => ({}),
	handlers: () => ({
		api: {
			products: {
				show: async ({ input, ctx }) => {
					const product = await ctx.connect.catalog.get({ sku: input.sku })
					return product.outcome === 'ok' ? { outcome: 'ok', name: product.value?.name ?? null } : { outcome: product.outcome, name: null }
				},
				other: ({ ctx }) => ({ connect: 'connect' in ctx }),
			},
		},
	}),
})
