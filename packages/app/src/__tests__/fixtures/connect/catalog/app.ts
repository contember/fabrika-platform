// The catalog's handlers over an in-memory product list; the export serves the same rows as the API.

import { implement } from '@fabrika/app/implement'
import { contract } from './fabrika.contract'

export interface ProductRow {
	readonly sku: string
	readonly name: string
	readonly price: number
	readonly tags: readonly ('new' | 'sale')[]
	readonly internalCost: number
}

export function catalogApp(products: ReadonlyMap<string, ProductRow>) {
	const get = (sku: string) => {
		const row = products.get(sku)
		return row === undefined ? null : { sku: row.sku, name: row.name, price: row.price, tags: [...row.tags] }
	}
	return implement(contract, {
		database: null,
		deps: () => ({}),
		handlers: () => ({
			api: { products: { get: ({ input }) => get(input.sku) } },
			exports: {
				products: {
					get: ({ input }) => get(input.sku),
					list: () => ({ items: [...products.keys()].flatMap((sku) => get(sku) ?? []), next: null }),
				},
			},
		}),
	})
}
