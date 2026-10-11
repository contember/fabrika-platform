import { app } from '../kit-fixture/src/app-kit'
import { ById, Deal } from '../kit-fixture/src/schemas'

const deals = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } }),
}))

export const contract = app.contract((c) => ({
	// mistake: deals.get has no handler; the mount names it
	api: c.rpc('/api', { deals }),
}))
