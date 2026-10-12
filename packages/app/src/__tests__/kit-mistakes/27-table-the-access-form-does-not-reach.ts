import { app } from '../kit-fixture/src/app-kit'
import { OrgInput, Pipeline } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	stages: r.query({ input: OrgInput, output: Pipeline, access: { action: 'crm.read', in: 'org', from: 'orgId' } })
		.handle(async ({ ctx }) => {
			// mistake: deals lie in a company, not directly in the org
			await ctx.db.target.deals.list()
			return { rows: [] }
		}),
}))
