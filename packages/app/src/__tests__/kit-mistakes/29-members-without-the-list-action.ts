import { app } from '../kit-fixture/src/app-kit'
import { NewCompany, Saved } from '../kit-fixture/src/schemas'

export const companies = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({ input: NewCompany, output: Saved, access: { action: 'crm.write', in: 'org', from: 'orgId' } })
		.handle(async ({ input, ctx }) => {
			// mistake: crm.write neither lists nor manages the members of org
			await ctx.members.list()
			return ctx.db.target.companies.insert({ name: input.name })
		}),
}))
