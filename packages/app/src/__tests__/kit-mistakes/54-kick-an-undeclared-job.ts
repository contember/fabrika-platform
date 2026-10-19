import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }, kicks: ['close'] })
		.handle(({ ctx }) => {
			// mistake: the mutation kicks only the jobs its kicks lists
			ctx.kick('digest')
			return { id: ctx.target.value }
		}),
}))
