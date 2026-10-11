import { app } from '../kit-fixture/src/app-kit'
import { NewCompany, Saved } from '../kit-fixture/src/schemas'

export const imports = app.group({ callers: ['human'] }, (r) => ({
	run: r.mutation({ input: NewCompany, output: Saved, access: { member: true }, unscoped: { companies: 'write' } })
		.handle(({ input, ctx }) =>
			// mistake: an unscoped insert has no capability to stamp the organization from; it takes org_id
			ctx.db.unscoped.companies.insert({ name: input.name })
		),
}))
