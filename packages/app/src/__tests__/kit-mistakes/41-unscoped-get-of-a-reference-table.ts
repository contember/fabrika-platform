import { app } from '../kit-fixture/src/app-kit'
import { Country, Ok } from '../kit-fixture/src/schemas'

export const codes = app.group({ callers: ['human'] }, (r) => ({
	exists: r.query({ input: Country, output: Ok, access: { member: true }, unscoped: { countries: 'read' } })
		.handle(async ({ input, ctx }) => {
			// mistake: a reference table has no key, so no row is read by one
			await ctx.db.unscoped.countries.get(input.code)
			return { ok: true }
		}),
}))
