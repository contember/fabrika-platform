import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			// mistake: a site notifies only in a vocabulary that declares notifications
			await ctx.notify('someone', { title: 'Touched', body: 'A deal was touched', path: '/' }, { action: 'crm.read', on: { deal: ctx.target.value } })
			return { id: ctx.target.value }
		}),
}))
