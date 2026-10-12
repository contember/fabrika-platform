import { implement } from '../../implement/implement'
import { contract } from '../fixtures/connect-shop/fabrika.contract'
import { catalogProductsV1 } from '../fixtures/connect-shop/fabrika/connect/catalog.products.v1'

// the vendored snapshot types the call: a sku is a string
export const app = implement(contract, {
	database: null,
	connect: { catalog: catalogProductsV1 },
	deps: () => ({}),
	handlers: () => ({
		api: {
			products: {
				show: async ({ ctx }) => {
					// mistake: the input is not what the export declares
					const product = await ctx.connect.catalog.get({ sku: 42 })
					return { outcome: product.outcome, name: null }
				},
				other: () => ({ connect: false }),
			},
		},
	}),
})
