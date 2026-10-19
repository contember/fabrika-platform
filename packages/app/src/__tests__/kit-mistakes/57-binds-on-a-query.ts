import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	// mistake: a query writes nothing, so it writes no binding; binds belongs on a mutation
	get: r.query({ input: ById, output: ById, access: { action: 'crm.read', on: 'deal', from: 'id' }, binds: 'github' })
		.handle(({ ctx }) => ({ id: ctx.target.value })),
}))
