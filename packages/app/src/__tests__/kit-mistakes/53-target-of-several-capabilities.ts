import { z } from 'zod/v4'
import { app } from '../kit-fixture/src/app-kit'
import { Saved } from '../kit-fixture/src/schemas'

const Move = z.strictObject({ dealId: z.uuid(), companyId: z.string() })

export const moves = app.group({ callers: ['human'] }, (r) => ({
	copy: r.mutation({
		input: Move,
		output: Saved,
		access: {
			capabilities: {
				deal: { action: 'crm.read', on: 'deal', from: 'dealId' },
				into: { action: 'deals.write', in: 'company', from: 'companyId' },
			},
		},
	}).handle(async ({ ctx }) => {
		// mistake: an endpoint of several capabilities binds each by its name, it has no single target
		const deal = await ctx.db.target.get()
		return ctx.db.in(ctx.capabilities.into).deals.insert({ title: String(deal), stage: 'lead' })
	}),
}))
