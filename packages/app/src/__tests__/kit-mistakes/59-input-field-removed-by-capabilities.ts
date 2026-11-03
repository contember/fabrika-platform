import { z } from 'zod/v4'
import { app } from '../kit-fixture/src/app-kit'
import { Saved } from '../kit-fixture/src/schemas'

const Copy = z.strictObject({ dealId: z.uuid(), companyId: z.string(), title: z.string() })

export const copies = app.group({ callers: ['human'] }, (r) => ({
	copy: r.mutation({
		input: Copy,
		output: Saved,
		access: {
			capabilities: {
				deal: { action: 'crm.read', on: 'deal', from: 'dealId' },
				into: { action: 'deals.write', in: 'company', from: 'companyId' },
				orgs: { action: 'crm.read', over: 'org' },
			},
		},
	}).handle(async ({ input, ctx }) => {
		const deal = await ctx.db.on(ctx.capabilities.deal).get()
		const title: string = input.title
		// mistake: each capability's from field is gone from the input; its value is ctx.capabilities.into.value
		console.info(input.companyId)
		return ctx.db.in(ctx.capabilities.into).deals.insert({ title: `${title} (${deal.title})`, stage: 'lead' })
	}),
}))
