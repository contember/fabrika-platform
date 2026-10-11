import { app } from '../app-kit'
import { ById, Company, CountryPage, DealRecord, NewCompany, OrgInput, Saved } from '../schemas'

export const companies = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({ input: NewCompany, output: Saved, access: { action: 'crm.write', in: 'org', from: 'orgId' } })
		.handle(({ input, ctx }) => ctx.db.target.companies.insert({ name: input.name })),
	audit: r.query({ input: OrgInput, output: Company, access: { action: 'crm.read', in: 'org', from: 'orgId' }, unscoped: { companies: 'read' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.unscoped.companies.list({ limit: 1 })
			const first = page.items[0]
			return { id: first?.id ?? '', name: first?.name ?? '' }
		}),
	// A projected row or page is returned as it is: the hidden columns are not in it.
	countries: r.query({ output: CountryPage, access: { member: true } })
		.handle(({ ctx }) => ctx.db.reference.countries.list()),
	deal: r.query({ input: ById, output: DealRecord, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(({ ctx }) => ctx.db.target.get()),
}))
