import { attachment } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../kit-fixture/src/app-kit'
import { OrgInput } from '../kit-fixture/src/schemas'

const DealExport = attachment({
	format: 'csv',
	filename: 'deals.csv',
	row: z.strictObject({ title: z.string(), stage: z.string() }),
	maxBytes: 1_000_000,
})

export const deals = app.group({ callers: ['human'] }, (r) => ({
	// mistake: an attachment's handler returns the rows, not a page of them
	exportDeals: r.query({ input: OrgInput, output: DealExport, access: { action: 'crm.read', over: 'org' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.within.deals.list({ limit: 100 })
			return { items: page.items.map((deal) => ({ title: deal.title, stage: deal.stage })) }
		}),
}))
