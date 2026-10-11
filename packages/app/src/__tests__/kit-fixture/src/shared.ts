import { app } from './app-kit'
import { Deal } from './schemas'

export const shared = app.link('/s', {
	spa: 'dist/share',
	dimension: 'deal',
	grants: ['crm.read'],
	issuedBy: 'deals.share',
	maxDays: 30,
	procedures: (l) => ({
		deal: l.query({ output: Deal, access: { action: 'crm.read' } })
			.handle(async ({ ctx }) => {
				const deal = await ctx.db.target.get()
				return { id: deal.id, title: deal.title, stage: deal.stage }
			}),
	}),
})
