import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	// mistake: a procedure opts out of a caller row only where the kit declares one
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }, caller: false })
		.handle(({ ctx }) => ({ id: ctx.target.value })),
}))
