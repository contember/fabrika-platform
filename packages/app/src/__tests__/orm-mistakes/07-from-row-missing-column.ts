import { fromRow } from '@fabrika/app'
import { app } from '../kit-fixture/src/app-kit'
import { ById, Company } from '../kit-fixture/src/schemas'

export const companies = app.group({ callers: ['human'] }, (r) => ({
	name: r.query({ input: ById, output: Company, access: { action: 'crm.read', over: 'org' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.within.companies.list({ limit: 1 })
			const [first] = page.items
			// mistake: Company declares name, and the row given has only its id
			return fromRow(Company, { id: first?.id ?? '' })
		}),
}))
