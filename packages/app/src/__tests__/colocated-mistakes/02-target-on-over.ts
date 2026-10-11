import { app } from '../kit-fixture/src/app-kit'
import { ById, OrgInput } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	first: r.query({ input: OrgInput, output: ById, access: { action: 'crm.read', over: 'org' } })
		// mistake: an over endpoint holds ctx.within, the scopes it lists in, not ctx.target
		.handle(({ ctx }) => ({ id: ctx.target.value })),
}))
