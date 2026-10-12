import { implement } from '../../implement/implement'
import { contract } from '../fixtures/connect-shop/fabrika.contract'
import { catalogProductsV1 } from '../fixtures/connect-shop/fabrika/connect/catalog.products.v1'

// the import's usedBy names only api.products.show, and api.products.other reaches for the connector anyway
export const app = implement(contract, {
	database: null,
	connect: { catalog: catalogProductsV1 },
	deps: () => ({}),
	handlers: () => ({
		api: {
			products: {
				show: async ({ input, ctx }) => {
					const product = await ctx.connect.catalog.get({ sku: input.sku })
					return { outcome: product.outcome, name: null }
				},
				other: async ({ ctx }) => {
					// mistake: ctx.connect exists only in the handlers the import's usedBy names
					await ctx.connect.catalog.get({ sku: 'a' })
					return { connect: true }
				},
			},
		},
	}),
})
