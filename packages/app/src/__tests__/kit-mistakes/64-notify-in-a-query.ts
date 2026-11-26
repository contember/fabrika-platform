import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: ById, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			// mistake: a query writes nothing, so it notifies no one
			await ctx.notify('someone', { title: 'Read', body: 'A deal was read', path: '/' }, { action: 'crm.read', on: { deal: ctx.target.value } })
			return { id: ctx.target.value }
		}),
}))
