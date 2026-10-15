import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	// mistake: a query writes nothing, so it kicks no job; then belongs on a mutation
	get: r.query({ input: ById, output: ById, access: { action: 'crm.read', on: 'deal', from: 'id' }, then: 'close' })
		.handle(({ ctx }) => ({ id: ctx.target.value })),
}))
