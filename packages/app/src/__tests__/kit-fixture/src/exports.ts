import { app } from './app-kit'
import { ById, Deal } from './schemas'

export const pipeline = app.export({
	version: 1,
	consumers: ['billing'],
	audience: 'any consumer user',
	procedures: (e) => ({
		deal: e.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } })
			.handle(async ({ ctx }) => {
				const deal = await ctx.db.target.get()
				return { id: deal.id, title: deal.title, stage: deal.stage }
			}),
	}),
})
