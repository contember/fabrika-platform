import { app } from '../kit-fixture/src/app-kit'
import { Country, Ok } from '../kit-fixture/src/schemas'

const reach: { readonly countries: 'read' | 'write' } = { countries: 'write' }

export const codes = app.group({ callers: ['human'] }, (r) => ({
	rename: r.mutation({
		input: Country,
		output: Ok,
		access: { member: true },
		// mistake: a mode typed 'read' | 'write' may write, and no site writes a reference table
		unscoped: reach,
	})
		.handle(() => ({ ok: true })),
}))
