import { app } from '../kit-fixture/src/app-kit'
import { Country, Ok } from '../kit-fixture/src/schemas'

export const codes = app.group({ callers: ['human'] }, (r) => ({
	rename: r.mutation({
		input: Country,
		output: Ok,
		access: { member: true },
		// mistake: no site writes a reference table, and this one declares countries unscoped: 'write'
		unscoped: { countries: 'write' },
	})
		.handle(() => ({ ok: true })),
}))
