import { implement } from '../../implement/implement'
import { contract } from '../fixtures/connect-catalog/fabrika.contract'

// every exported procedure needs its handler under handlers.exports
export const app = implement(contract, {
	database: null,
	deps: () => ({}),
	handlers: () => ({
		api: { products: { get: () => null } },
		exports: {
			// mistake: list has no handler
			products: {
				get: () => null,
			},
		},
	}),
})
