import { app } from '../kit-fixture/src/app-kit'
import { NewCompany, Ok } from '../kit-fixture/src/schemas'

export const companies = app.group({ callers: ['human'] }, (r) => ({
	rename: r.mutation({ input: NewCompany, output: Ok, access: { action: 'crm.write', in: 'org', from: 'orgId' } })
		.handle(async ({ input, ctx }) => {
			// mistake: an in endpoint holds the container; an update acts on one object, through access with on
			await ctx.db.target.update({ name: input.name }, { expectVersion: 1 })
			return { ok: true }
		}),
}))
