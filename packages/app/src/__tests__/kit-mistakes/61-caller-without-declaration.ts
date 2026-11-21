import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(({ ctx }) => {
			// mistake: ctx.caller is the row of the table defineApp's caller declares
			return { id: ctx.caller.id }
		}),
}))
