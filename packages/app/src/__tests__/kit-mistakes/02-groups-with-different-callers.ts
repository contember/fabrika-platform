import { app } from '../kit-fixture/src/app-kit'
import { deals } from '../kit-fixture/src/deals/endpoints'
import { OrgInput, Saved } from '../kit-fixture/src/schemas'

const imports = app.group({ callers: ['machine'] }, (r) => ({
	run: r.mutation({ input: OrgInput, output: Saved, access: { action: 'crm.write', in: 'org', from: 'orgId' } })
		.handle(({ ctx }) => ctx.db.target.companies.insert({ name: 'imported' })),
}))

export const contract = app.contract((c) => ({
	// mistake: one RPC mount serves one set of callers, and these groups name two
	api: c.rpc('/api', { deals, imports }),
}))
