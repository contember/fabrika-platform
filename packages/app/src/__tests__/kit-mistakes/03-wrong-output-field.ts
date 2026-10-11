import { app } from '../kit-fixture/src/app-kit'
import { ById, Deal } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	// mistake: the whole row goes out, company_id, org_id, created_by and version included
	get: r.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(({ ctx }) => ctx.db.target.get()),
}))
