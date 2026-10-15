import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

const job: string = 'close'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	// mistake: a string-typed job name could be any job; then names one, as a literal
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }, then: job })
		.handle(({ ctx }) => ({ id: ctx.target.value })),
}))
