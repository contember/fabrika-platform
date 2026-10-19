import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(({ ctx }) => {
			// mistake: a site kicks a job only after it declares kicks
			ctx.kick('close')
			return { id: ctx.target.value }
		}),
}))
