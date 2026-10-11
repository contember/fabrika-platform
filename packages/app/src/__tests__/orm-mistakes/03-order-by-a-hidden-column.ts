import { app } from '../kit-fixture/src/app-kit'
import { DealPage, OrgInput } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	byMargin: r.query({ input: OrgInput, output: DealPage, access: { action: 'crm.read', over: 'company' } })
		.handle(async ({ ctx }) => {
			// mistake: margin declares its own read action, so a crm.read list can neither return nor order by it
			const page = await ctx.db.within.deals.list({ orderBy: [['margin', 'desc']] })
			return { items: page.items.map((deal) => ({ id: deal.id, title: deal.title, stage: deal.stage })), next: page.next }
		}),
}))
