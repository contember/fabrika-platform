// The handlers of `fabrika.contract.ts`. The proxy already selected the endpoint and checked the caller; the framework
// verified the injected token and the requirement, and hands each handler only what its access form grants.

import { implement } from '@fabrika/app/implement'
import { contract } from '../fabrika.contract'

/** `all` is a global grant: the caller may act in every value of the dimension, including ones created later. */
const readable = (values: readonly string[] | 'all') => values === 'all' ? { all: true, values: [] } : { all: false, values: [...values] }

export default implement(contract, {
	database: null,
	deps: () => ({}),
	handlers: () => ({
		api: {
			me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
			projects: {
				readable: ({ ctx }) => readable(ctx.within.values),
			},
			organizations: {
				readable: ({ ctx }) => readable(ctx.within.values),
			},
		},
	}),
})
