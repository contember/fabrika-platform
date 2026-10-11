import { app } from '../kit-fixture/src/app-kit'
import { DealPage, OrgInput } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	open: r.query({ input: OrgInput, output: DealPage, access: { action: 'crm.read', over: 'company' } })
		.handle(async ({ ctx }) => {
			// mistake: stage is one of the enum's labels
			const page = await ctx.db.within.deals.list({ where: [['stage', '=', 'open']] })
			return { items: page.items.map((deal) => ({ id: deal.id, title: deal.title, stage: deal.stage })), next: page.next }
		}),
}))
