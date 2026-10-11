import { app } from '../kit-fixture/src/app-kit'
import { ById, Company, Deal } from '../kit-fixture/src/schemas'

const deals = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			const deal = await ctx.db.target.get()
			return { id: deal.id, title: deal.title, stage: deal.stage }
		}),
}))

const companies = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Company, access: { action: 'crm.read', on: 'company', from: 'id' } }),
}))

export const contract = app.contract((c) => ({
	// mistake: companies.get, in the v1 namespace, has no handler; the mount names it by its path
	api: c.rpc('/api', { v1: { deals, companies } }),
}))
